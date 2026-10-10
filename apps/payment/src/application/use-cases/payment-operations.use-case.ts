import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  AuthorizePaymentRequest,
  AuthorizePaymentResponse,
  CapturePaymentRequest,
  CapturePaymentResponse,
  PaymentCommand,
  RefundPaymentRequest,
  RefundPaymentResponse,
  VoidPaymentRequest,
  VoidPaymentResponse,
} from "@food-delivery/contracts";
import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  ValidationError,
  getCorrelationId,
  runWithContext,
} from "@food-delivery/shared";
import { assertAmount } from "../../domain/money";
import type { OperationType, Payment } from "../../domain/payment";
import { PaymentRuleError } from "../../domain/payment-errors";
import { paymentEvents } from "../payment-events";
import {
  PAYMENT_PROVIDER,
  ProviderRejectedError,
  type PaymentProvider,
  type ProviderPaymentStatus,
} from "../ports/payment-provider";
import {
  PAYMENT_REPOSITORY,
  type Completion,
  type PaymentRepository,
  type StartedOperation,
  type TransactionRecord,
} from "../ports/payment.repository";

/**
 * Платёжные операции (PAY-1..4, PAY-6).
 *
 * Сервис — ведомый участник саги: выполняет ровно одну операцию за вызов
 * и не знает, что будет дальше. Решение «списать» или «вернуть» принимает
 * `order`.
 *
 * Идемпотентность (PAY-4) держится на трёх вещах:
 *   — запись операции создаётся под уникальным ключом, и повтор находит её,
 *     а не проходит проверку «сначала выбрать» вместе с оригиналом;
 *   — провайдеру уходит тот же ключ: если до него дошли оба повтора,
 *     деньги он двигает один раз;
 *   — итог фиксируется только поверх записи в статусе PENDING, поэтому
 *     из двадцати одновременных повторов событие публикует ровно один.
 *
 * Сбой связи с провайдером оставляет операцию в PENDING и возвращается
 * вызывающему как повторяемая ошибка. Дальше операцией распоряжается
 * вызывающий: повторяет с тем же ключом или отказывается от неё и начинает
 * другую (компенсацию). Сам сервис брошенную операцию не выполняет —
 * иначе списание, от которого оркестратор уже отказался и вместо которого
 * снимает холд, прошло бы позже и потребовало бы возврата. Незавершённые
 * операции закрываются по фактическому состоянию платежа у провайдера:
 * при начале новой операции над платежом и при сверке (`reconcile`).
 */

const MAX_KEY_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentOperationSettings {
  /**
   * Сколько незавершённая операция считается «ещё выполняющейся». Должно
   * быть больше полного времени вызова провайдера с повторами: младшую
   * операцию нельзя закрывать — её ответ, возможно, ещё в пути.
   */
  inFlightMs: number;
}

export const PAYMENT_OPERATION_SETTINGS = Symbol("PaymentOperationSettings");

const DEFAULT_SETTINGS: PaymentOperationSettings = { inFlightMs: 5_000 };

@Injectable()
export class PaymentOperationsUseCase {
  private readonly settings: PaymentOperationSettings;

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Optional()
    @Inject(PAYMENT_OPERATION_SETTINGS)
    settings?: PaymentOperationSettings,
  ) {
    this.settings = settings ?? DEFAULT_SETTINGS;
  }

  async authorize(request: AuthorizePaymentRequest): Promise<AuthorizePaymentResponse> {
    validateCommand(request);
    if (!UUID.test(request.customerId ?? "")) {
      throw new ValidationError("customerId: нужен идентификатор клиента");
    }
    if (request.currency !== "RUB") {
      throw new ValidationError("currency: поддерживаются только рубли");
    }
    rule(() => assertAmount(request.amount));

    const started = await this.payments.startAuthorization({
      orderId: request.orderId,
      customerId: request.customerId,
      amount: request.amount,
      idempotencyKey: request.idempotencyKey,
      correlationId: getCorrelationId(),
    });
    ensureSameOperation(started, "AUTHORIZE", request.orderId, request.amount);
    return this.settle<AuthorizePaymentResponse>(started);
  }

  async capture(request: CapturePaymentRequest): Promise<CapturePaymentResponse> {
    validateCommand(request);
    const started = await this.start(request, (payment) => payment.planCapture());
    if (!started.transaction) throw new DomainRuleError("по заказу нет платежа для списания");
    ensureSameOperation(started, "CAPTURE", request.orderId);
    return this.settle<CapturePaymentResponse>(started);
  }

  /** Снятие холда — компенсация; без холда возвращает `voided: false`. */
  async void(request: VoidPaymentRequest): Promise<VoidPaymentResponse> {
    validateCommand(request);
    const started = await this.start(request, (payment) => payment.planVoid());
    if (!started.transaction) {
      return { paymentId: started.payment?.id ?? null, voided: false };
    }
    ensureSameOperation(started, "VOID", request.orderId);
    return this.settle<VoidPaymentResponse>(started);
  }

  async refund(request: RefundPaymentRequest): Promise<RefundPaymentResponse> {
    validateCommand(request);
    rule(() => assertAmount(request.amount));
    const started = await this.start(request, (payment) => payment.planRefund(request.amount));
    if (!started.transaction) throw new DomainRuleError("по заказу нет платежа для возврата");
    ensureSameOperation(started, "REFUND", request.orderId, request.amount);
    return this.settle<RefundPaymentResponse>(started);
  }

  /**
   * Сверка незавершённой операции после сбоя — с тем же сквозным
   * идентификатором, что у исходного запроса.
   *
   * Холд повторяется у провайдера с тем же ключом: идентификатора платежа
   * у провайдера ещё нет, узнать результат можно только так, а поздний холд
   * безопасен — `order` получит `PaymentAuthorized` и, если заказ уже
   * отменён, снимет его. Остальные операции не повторяются, а только
   * сверяются: прошла у провайдера — фиксируется; не прошла — остаётся
   * вызывающему, который либо повторит её, либо начнёт другую.
   *
   * @returns закрыта ли операция
   */
  reconcile(started: StartedOperation): Promise<boolean> {
    return runWithContext(
      { correlationId: started.transaction.request.correlationId },
      async () => {
        if (started.transaction.type === "AUTHORIZE") {
          await this.settle(started).catch((error) => {
            if (!(error instanceof DomainRuleError)) throw error;
          });
          return true;
        }
        const status = await this.statusOf(started.payment);
        if (!happened(started.transaction, started.payment, status)) return false;
        await this.succeed(started.transaction);
        return true;
      },
    );
  }

  /**
   * Начало операции над платежом заказа. Если по платежу висят незавершённые
   * операции с другими ключами — вызывающий от них отказался, раз начинает
   * новую. Они закрываются по состоянию у провайдера до того, как начнётся
   * новая: иначе снятие холда проверялось бы по устаревшему статусу.
   */
  private async start(
    command: PaymentCommand,
    plan: Parameters<PaymentRepository["startOperation"]>[3],
  ) {
    const open = await this.payments.openOperations(command.orderId);
    const stale = open?.transactions.filter((t) => t.idempotencyKey !== command.idempotencyKey);
    if (open && stale && stale.length > 0) await this.closeSuperseded(open.payment, stale);

    try {
      return await this.payments.startOperation(
        command.orderId,
        command.idempotencyKey,
        getCorrelationId(),
        plan,
      );
    } catch (error) {
      throw toAppError(error);
    }
  }

  private async closeSuperseded(payment: Payment, stale: TransactionRecord[]): Promise<void> {
    // Незавершённый холд закрывает сверка: без идентификатора платежа
    // у провайдера спросить о нём нечего.
    const closable = stale.filter((t) => t.type !== "AUTHORIZE");
    if (closable.length === 0) return;

    const now = Date.now();
    if (closable.some((t) => now - t.createdAt.getTime() < this.settings.inFlightMs)) {
      throw new ExternalServiceError("предыдущая операция по платежу ещё выполняется — повторите", {
        paymentId: payment.id,
      });
    }

    const status = await this.statusOf(payment);
    for (const transaction of closable) {
      if (happened(transaction, payment, status)) {
        await this.succeed(transaction);
      } else {
        await this.finish(transaction, () => ({
          status: "FAILED",
          errorCode: "SUPERSEDED",
          outcome: { rejected: "операция не выполнена провайдером и заменена более новой" },
          events: [],
        }));
      }
    }
  }

  private async statusOf(payment: Payment): Promise<ProviderPaymentStatus> {
    const providerPaymentId = payment.snapshot.providerPaymentId;
    if (!providerPaymentId) {
      throw new ExternalServiceError("состояние платежа у провайдера неизвестно", {
        paymentId: payment.id,
      });
    }
    try {
      return await this.provider.status(providerPaymentId);
    } catch (error) {
      throw toAppError(error);
    }
  }

  private async settle<T>(started: StartedOperation): Promise<T> {
    if (started.transaction.status !== "PENDING") return replay<T>(started.transaction);

    let finished: TransactionRecord;
    try {
      finished = await this.drive(started);
    } catch (error) {
      if (!(error instanceof ProviderRejectedError)) throw toAppError(error);
      finished = await this.reject(started, error);
    }
    return replay<T>(finished);
  }

  /** Вызов провайдера вне транзакции базы и фиксация его итога. */
  private async drive({ payment, transaction }: StartedOperation): Promise<TransactionRecord> {
    const idempotencyKey = transaction.idempotencyKey;
    const providerPaymentId = payment.snapshot.providerPaymentId ?? "";
    const amount = transaction.amount;

    switch (transaction.type) {
      case "AUTHORIZE": {
        const hold = await this.provider.hold({
          orderId: payment.snapshot.orderId,
          amount,
          currency: "RUB",
          idempotencyKey,
        });
        return this.finish(transaction, (current, at) => {
          if (hold.held) {
            current.authorized(hold.providerPaymentId, at);
            return success(
              { paymentId: current.id, status: "AUTHORIZED" },
              [paymentEvents.authorized(current, at)],
              hold.providerPaymentId,
            );
          }
          const reason = hold.declineReason ?? "банк отклонил операцию";
          current.declined(hold.providerPaymentId);
          return {
            status: "FAILED",
            errorCode: "DECLINED",
            providerRef: hold.providerPaymentId,
            // Отказ банка — штатный ответ по контракту, а не ошибка вызова.
            outcome: {
              result: { paymentId: current.id, status: "DECLINED", declineReason: reason },
            },
            events: [paymentEvents.failed(current, "AUTHORIZE", reason, at)],
          };
        });
      }
      case "CAPTURE":
        await this.provider.capture({ providerPaymentId, amount, idempotencyKey });
        return this.succeed(transaction);
      case "VOID":
        await this.provider.cancel({ providerPaymentId, idempotencyKey });
        return this.succeed(transaction);
      case "REFUND": {
        const { refundId } = await this.provider.refund({
          providerPaymentId,
          amount,
          idempotencyKey,
        });
        return this.succeed(transaction, refundId);
      }
    }
  }

  /** Операция прошла у провайдера: новое состояние платежа, ответ и событие. */
  private succeed(transaction: TransactionRecord, providerRef?: string) {
    const amount = transaction.amount;
    return this.finish(transaction, (current, at) => {
      switch (transaction.type) {
        case "CAPTURE":
          current.captured(at);
          return success({ paymentId: current.id, status: "CAPTURED", amount }, [
            paymentEvents.captured(current, at),
          ]);
        case "VOID":
          current.voided();
          return success({ paymentId: current.id, voided: true }, [
            paymentEvents.voided(current, at),
          ]);
        case "REFUND":
          current.refunded(amount);
          return success(
            {
              paymentId: current.id,
              status: current.status,
              refundedTotal: current.snapshot.refundedAmount,
            },
            [paymentEvents.refunded(current, amount, at)],
            providerRef,
          );
        case "AUTHORIZE":
          throw new PaymentRuleError("итог холда фиксируется только по ответу провайдера");
      }
    });
  }

  /** Провайдер отказал по существу: операция завершается неуспешно, повтор её не выполнит. */
  private reject({ transaction }: StartedOperation, error: ProviderRejectedError) {
    return this.finish(transaction, (current, at) => ({
      status: "FAILED",
      errorCode: error.code,
      outcome: { rejected: `провайдер отклонил операцию: ${error.message}` },
      events: [paymentEvents.failed(current, transaction.type, error.message, at)],
    }));
  }

  private async finish(
    transaction: TransactionRecord,
    complete: (payment: Payment, at: Date) => Completion,
  ): Promise<TransactionRecord> {
    try {
      return await this.payments.finish(transaction.id, (payment) => complete(payment, new Date()));
    } catch (error) {
      throw toAppError(error);
    }
  }
}

/** Прошла ли операция у провайдера — по фактическому состоянию платежа. */
function happened(
  transaction: TransactionRecord,
  payment: Payment,
  status: ProviderPaymentStatus,
): boolean {
  switch (transaction.type) {
    case "CAPTURE":
      return status.status === "succeeded";
    case "VOID":
      return status.status === "canceled";
    case "REFUND":
      return status.refundedAmount >= payment.snapshot.refundedAmount + transaction.amount;
    case "AUTHORIZE":
      return false;
  }
}

function success(result: unknown, events: Completion["events"], providerRef?: string): Completion {
  return { status: "SUCCEEDED", outcome: { result }, providerRef: providerRef ?? null, events };
}

/** Повтор с тем же ключом получает сохранённый итог — тот же, что получил оригинал. */
function replay<T>(transaction: TransactionRecord): T {
  const outcome = transaction.outcome;
  if (!outcome) {
    throw new ConflictError("операция с этим ключом ещё выполняется — повторите позже", {
      idempotencyKey: transaction.idempotencyKey,
    });
  }
  if ("rejected" in outcome) {
    throw new DomainRuleError(outcome.rejected, { operation: transaction.type });
  }
  return outcome.result as T;
}

/**
 * Ключ идемпотентности привязан к одной операции. Тот же ключ с другим
 * заказом, типом или суммой — ошибка вызывающего, а не повтор: выполнять
 * её как повтор значило бы молча вернуть ответ на другой вопрос.
 */
function ensureSameOperation(
  { payment, transaction }: StartedOperation,
  type: OperationType,
  orderId: string,
  amount?: number,
): void {
  if (
    transaction.type !== type ||
    payment.snapshot.orderId !== orderId ||
    (amount !== undefined && transaction.amount !== amount)
  ) {
    throw new ConflictError("ключ идемпотентности уже использован для другой операции", {
      idempotencyKey: transaction.idempotencyKey,
    });
  }
}

function validateCommand(command: PaymentCommand): void {
  if (!UUID.test(command?.orderId ?? "")) {
    throw new ValidationError("orderId: нужен идентификатор заказа");
  }
  const key = command.idempotencyKey;
  if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`idempotencyKey: нужна строка до ${MAX_KEY_LENGTH} символов`);
  }
}

function rule(check: () => void): void {
  try {
    check();
  } catch (error) {
    throw toAppError(error);
  }
}

function toAppError(error: unknown): unknown {
  if (error instanceof PaymentRuleError) return new DomainRuleError(error.message, error.details);
  return error;
}
