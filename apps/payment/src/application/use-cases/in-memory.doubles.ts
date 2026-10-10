import { randomUUID } from "node:crypto";
import { ExternalServiceError, type DomainEvent } from "@food-delivery/shared";
import { Payment, type PaymentState } from "../../domain/payment";
import {
  ProviderRejectedError,
  type HoldRequest,
  type HoldResult,
  type PaymentProvider,
  type ProviderOperation,
  type ProviderPaymentStatus,
} from "../ports/payment-provider";
import type {
  PaymentHistory,
  PaymentRepository,
  StartedOperation,
  TransactionRecord,
} from "../ports/payment.repository";

/**
 * Тестовые дубли: хранилище в памяти с той же семантикой, что у базы
 * (уникальные ключи, итог только поверх PENDING), и провайдер с теми же
 * правилами, что у эмулятора. Сценарии проверяются без сети и базы.
 */

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryPaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, PaymentState>();
  readonly transactions = new Map<string, TransactionRecord>();
  readonly outbox: DomainEvent[] = [];

  async startAuthorization(input: Parameters<PaymentRepository["startAuthorization"]>[0]) {
    const existing = this.byKey(input.idempotencyKey);
    if (existing) return existing;

    const payment = Payment.open({
      id: randomUUID(),
      orderId: input.orderId,
      customerId: input.customerId,
      amount: input.amount,
    });
    this.payments.set(payment.id, clone(payment.snapshot));
    const transaction = this.insert(payment.id, "AUTHORIZE", input.amount, input);
    return {
      payment: Payment.restore(this.payments.get(payment.id)!),
      transaction: clone(transaction),
    };
  }

  async startOperation(
    orderId: string,
    idempotencyKey: string,
    correlationId: string,
    plan: Parameters<PaymentRepository["startOperation"]>[3],
  ) {
    const existing = this.byKey(idempotencyKey);
    if (existing) return existing;

    const state = [...this.payments.values()].filter((p) => p.orderId === orderId).at(-1);
    if (!state) return { payment: null, transaction: null };

    const payment = Payment.restore(state);
    const planned = plan(payment);
    if (!planned) return { payment, transaction: null };

    const transaction = this.insert(payment.id, planned.type, planned.amount, {
      idempotencyKey,
      correlationId,
    });
    return { payment, transaction: clone(transaction) };
  }

  async finish(
    transactionId: string,
    complete: Parameters<PaymentRepository["finish"]>[1],
  ): Promise<TransactionRecord> {
    const transaction = this.transactions.get(transactionId)!;
    if (transaction.status !== "PENDING") return clone(transaction);

    const payment = Payment.restore(this.payments.get(transaction.paymentId)!);
    const result = complete(payment, clone(transaction));

    // Как в транзакции базы: всё применяется вместе — или ничего.
    this.payments.set(payment.id, {
      ...clone(payment.snapshot),
      version: payment.snapshot.version + 1,
    });
    Object.assign(transaction, {
      status: result.status,
      outcome: result.outcome,
      providerRef: result.providerRef ?? null,
      errorCode: result.errorCode ?? null,
      finishedAt: new Date(),
    });
    this.outbox.push(...result.events);
    return clone(transaction);
  }

  async openOperations(orderId: string) {
    const state = [...this.payments.values()].filter((p) => p.orderId === orderId).at(-1);
    if (!state) return null;
    return {
      payment: Payment.restore(state),
      transactions: [...this.transactions.values()]
        .filter((t) => t.paymentId === state.id && t.status === "PENDING")
        .map(clone),
    };
  }

  async pending(
    olderThanMs: number,
    youngerThanMs: number,
    limit: number,
  ): Promise<StartedOperation[]> {
    const age = (t: TransactionRecord) => Date.now() - t.createdAt.getTime();
    return [...this.transactions.values()]
      .filter((t) => t.status === "PENDING" && age(t) >= olderThanMs && age(t) <= youngerThanMs)
      .slice(0, limit)
      .map((t) => ({
        payment: Payment.restore(this.payments.get(t.paymentId)!),
        transaction: clone(t),
      }));
  }

  async history(orderId: string): Promise<PaymentHistory> {
    const payments = [...this.payments.values()].filter((p) => p.orderId === orderId);
    const ids = new Set(payments.map((p) => p.id));
    return {
      payments: clone(payments),
      transactions: [...this.transactions.values()].filter((t) => ids.has(t.paymentId)).map(clone),
    };
  }

  eventsOfType(type: string) {
    return this.outbox.filter((event) => event.eventType === type);
  }

  private byKey(key: string): StartedOperation | null {
    const transaction = [...this.transactions.values()].find((t) => t.idempotencyKey === key);
    if (!transaction) return null;
    return {
      payment: Payment.restore(this.payments.get(transaction.paymentId)!),
      transaction: clone(transaction),
    };
  }

  private insert(
    paymentId: string,
    type: TransactionRecord["type"],
    amount: number,
    input: { idempotencyKey: string; correlationId: string },
  ) {
    const transaction: TransactionRecord = {
      id: randomUUID(),
      paymentId,
      type,
      amount,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey,
      request: { amount, correlationId: input.correlationId },
      outcome: null,
      providerRef: null,
      errorCode: null,
      createdAt: new Date(),
      finishedAt: null,
    };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }
}

type ProviderPayment = { id: string; status: string; amount: number; refunded: number };

/**
 * Провайдер с правилами эмулятора: идемпотентность по ключу и собственный
 * автомат платежа. Режимы отказов — как у эмулятора.
 */
export class FakeProvider implements PaymentProvider {
  readonly payments = new Map<string, ProviderPayment>();
  private readonly byKey = new Map<string, unknown>();
  /** Сколько раз деньги действительно двигались — по операциям. */
  readonly moved = { hold: 0, capture: 0, cancel: 0, refund: 0 };
  calls = 0;

  failNext: "before" | "after" | null = null;
  declineAbove: number | null = null;
  delayMs = 0;

  hold(request: HoldRequest) {
    return this.run<HoldResult>("hold", request.idempotencyKey, () => {
      const id = `prov-${randomUUID()}`;
      const declined = this.declineAbove !== null && request.amount > this.declineAbove;
      this.payments.set(id, {
        id,
        status: declined ? "canceled" : "waiting_for_capture",
        amount: request.amount,
        refunded: 0,
      });
      return declined
        ? { providerPaymentId: id, held: false, declineReason: "insufficient_funds" }
        : { providerPaymentId: id, held: true };
    });
  }

  capture(request: ProviderOperation & { amount: number }) {
    return this.run<void>("capture", request.idempotencyKey, () => {
      const payment = this.require(request.providerPaymentId, "waiting_for_capture");
      payment.status = "succeeded";
    });
  }

  cancel(request: ProviderOperation) {
    return this.run<void>("cancel", request.idempotencyKey, () => {
      const payment = this.require(request.providerPaymentId, "waiting_for_capture");
      payment.status = "canceled";
    });
  }

  refund(request: ProviderOperation & { amount: number }) {
    return this.run<{ refundId: string }>("refund", request.idempotencyKey, () => {
      const payment = this.require(request.providerPaymentId, "succeeded");
      if (payment.refunded + request.amount > payment.amount) {
        throw new ProviderRejectedError("refund amount exceeds payment", "invalid_request");
      }
      payment.refunded += request.amount;
      return { refundId: `refund-${randomUUID()}` };
    });
  }

  async status(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    this.calls += 1;
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new ProviderRejectedError("payment not found", "not_found");
    return {
      status: payment.status as ProviderPaymentStatus["status"],
      refundedAmount: payment.refunded,
    };
  }

  /** Отказ на одной операции, пока не снят, — как `failOperation` эмулятора. */
  failOperation: keyof FakeProvider["moved"] | null = null;

  private require(id: string, status: string) {
    const payment = this.payments.get(id);
    if (!payment || payment.status !== status) {
      throw new ProviderRejectedError(`payment is not ${status}`, "invalid_request");
    }
    return payment;
  }

  private async run<T>(
    operation: keyof FakeProvider["moved"],
    key: string,
    action: () => T,
  ): Promise<T> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failOperation === operation) {
      throw new ExternalServiceError(`провайдер: отказ операции ${operation}`);
    }
    if (this.failNext === "before") {
      this.failNext = null;
      throw new ExternalServiceError("провайдер недоступен");
    }
    if (!this.byKey.has(key)) {
      this.byKey.set(key, action());
      this.moved[operation] += 1;
    }
    if (this.failNext === "after") {
      // Операция выполнена, но ответ до вызывающего не дошёл.
      this.failNext = null;
      throw new ExternalServiceError("ответ провайдера потерян");
    }
    return this.byKey.get(key) as T;
  }
}
