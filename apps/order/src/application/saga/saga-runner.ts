import { Inject, Injectable } from "@nestjs/common";
import { ConflictError, isRetryable, runWithContext } from "@food-delivery/shared";
import { COMPENSATIONS, SAGA_STEPS } from "../../domain/checkout-saga";
import { SYSTEM, type Order } from "../../domain/order";
import type { OrderStatus } from "../../domain/order-status";
import {
  ORDER_REPOSITORY,
  type LoadedOrder,
  type OrderRepository,
  type SagaStepRecord,
} from "../ports/order.repository";
import {
  DELIVERY_PORT,
  PAYMENT_PORT,
  type DeliveryPort,
  type PaymentPort,
} from "../ports/participants";
import { SAGA_QUEUE, type ClaimedEntry, type SagaQueue } from "../ports/saga-queue";
import { ORDER_COMMITTER, type CommitOptions, type OrderCommitter } from "./order-committer";
import { ORDER_WORKFLOW, type OrderWorkflow } from "./order-workflow";
import { SAGA_SETTINGS, type SagaSettings } from "./saga-settings";

export type RunOutcome = "completed" | "retry" | "discarded";

/** Что делать по истечении срока статуса. */
const TIMEOUT_TEXT: Partial<Record<OrderStatus, { action: "cancel" | "alert"; text: string }>> = {
  CREATED: { action: "cancel", text: "заказ не перешёл к оплате вовремя" },
  PENDING_PAYMENT: { action: "cancel", text: "оплата не завершилась вовремя" },
  AWAITING_RESTAURANT: { action: "cancel", text: "ресторан не подтвердил заказ вовремя" },
  COOKING: { action: "alert", text: "готовка идёт вдвое дольше заявленного" },
  ASSIGNING_COURIER: { action: "alert", text: "курьер не найден вовремя" },
  IN_TRANSIT: { action: "alert", text: "доставка идёт дольше ожидаемого" },
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Исполнитель саги оформления (оркестрация).
 *
 * Единственный компонент, который знает последовательность шагов
 * и компенсаций. Участники — платежи и доставка — знают только свою
 * операцию и ничего не знают друг о друге (заметка «12 — Архитектурные
 * паттерны»: иначе оркестратор становится «божественным объектом»
 * наоборот — логика размазывается по участникам).
 *
 * Шаги выполняются фоновым процессом по записям в базе, а не в запросе
 * пользователя. Поэтому:
 *   — оформление заказа не ждёт платёжный сервис и не падает вместе с ним;
 *   — шаг переживает перезапуск: запись останется, шаг повторится;
 *   — повтор шага безопасен: ключ идемпотентности вызова тот же.
 *
 * Правила повторов: временный отказ участника повторяется с нарастающей
 * задержкой. Прямой шаг после исчерпания попыток сдаётся — заказ отменяется,
 * запускаются компенсации. Компенсация не сдаётся никогда: деньги обязаны
 * вернуться; после нескольких неудач зовётся оператор (REL-5).
 */
@Injectable()
export class SagaRunner {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(SAGA_QUEUE) private readonly queue: SagaQueue,
    @Inject(PAYMENT_PORT) private readonly payment: PaymentPort,
    @Inject(DELIVERY_PORT) private readonly delivery: DeliveryPort,
    @Inject(ORDER_WORKFLOW) private readonly workflow: OrderWorkflow,
    @Inject(ORDER_COMMITTER) private readonly committer: OrderCommitter,
    @Inject(SAGA_SETTINGS) private readonly settings: SagaSettings,
  ) {}

  async run(entry: ClaimedEntry, now = new Date()): Promise<RunOutcome> {
    const loaded = await this.orders.findById(entry.orderId);
    if (!loaded) {
      await this.queue.discard(entry, "заказ не найден");
      return "discarded";
    }
    // Шаг продолжает трассу действия, которое начало сагу: события шага,
    // записи журнала и вызовы участников связаны с оформлением заказа.
    return runWithContext({ correlationId: loaded.saga.correlationId, source: "saga" }, () =>
      this.dispatch(entry, loaded, now),
    );
  }

  private async dispatch(entry: ClaimedEntry, loaded: LoadedOrder, now: Date): Promise<RunOutcome> {
    try {
      if (entry.type.startsWith("TIMEOUT:")) return await this.onTimeout(entry, loaded, now);
      switch (entry.type) {
        case SAGA_STEPS.authorizePayment:
          return await this.authorize(entry, loaded, now);
        case SAGA_STEPS.capturePayment:
          return await this.capture(entry, loaded, now);
        case SAGA_STEPS.requestCourier:
          return await this.requestCourier(entry, loaded, now);
        case SAGA_STEPS.voidPayment:
          return await this.voidPayment(entry, loaded, now);
        case SAGA_STEPS.refundPayment:
          return await this.refund(entry, loaded, now);
        case SAGA_STEPS.releaseCourier:
          return await this.releaseCourier(entry, loaded, now);
        default:
          await this.queue.discard(entry, `неизвестный шаг ${entry.type}`);
          return "discarded";
      }
    } catch (error) {
      // Заказ изменили одновременно (кухня, клиент, событие участника).
      // Шаг повторится по свежему состоянию; вызов участника повторится
      // с тем же ключом и вернёт тот же результат.
      if (error instanceof ConflictError) {
        await this.queue.retryLater(entry, new Date(now.getTime() + 200), errorText(error), {
          step: entry.type,
          isCompensation: COMPENSATIONS.has(entry.type),
          status: "FAILED",
          attempt: entry.attempt,
          error: "конфликт версий, шаг будет повторён",
          startedAt: now,
          finishedAt: new Date(),
        });
        return "retry";
      }
      throw error;
    }
  }

  /* ─────────────── Прямые шаги ─────────────── */

  /** Шаг 3: холдирование средств (PAY-1). */
  private async authorize(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;

    // Переход «ожидает оплаты» фиксируется до вызова: так статус честно
    // показывает, что оплата идёт, а срок статуса начинает отсчёт.
    if (order.status === "CREATED") {
      order.startPayment(now);
      await this.committer.commit(loaded, now);
    }
    if (order.status !== "PENDING_PAYMENT") return this.drop(entry, "заказ уже не ждёт оплаты");

    const request = {
      orderId: order.id,
      customerId: order.customerId,
      amount: order.amounts.total,
      currency: "RUB" as const,
      idempotencyKey: `${order.id}:authorize`,
    };
    const started = new Date();
    try {
      const result = await this.payment.authorize(request);
      const step = this.step(entry, started, "SUCCEEDED", { amount: request.amount }, result);

      if (result.status === "AUTHORIZED") {
        saga.record({ paymentAuthorized: true, paymentId: result.paymentId });
        order.markPaid(now);
        await this.committer.commit(loaded, now, { completeEntryId: entry.id, steps: [step] });
      } else {
        saga.record({ paymentId: result.paymentId });
        order.cancel(
          SYSTEM,
          "PAYMENT_FAILED",
          `платёж отклонён: ${result.declineReason ?? "без причины"}`,
          now,
        );
        await this.committer.commit(loaded, now, {
          completeEntryId: entry.id,
          steps: [step],
          plan: { holdOutcomeKnown: true },
        });
      }
      return "completed";
    } catch (error) {
      return this.onForwardFailure(entry, loaded, now, started, error, {
        attempts: this.settings.authorizeAttempts,
        giveUp: () =>
          order.cancel(SYSTEM, "TECHNICAL", `оплата не прошла: ${errorText(error)}`, now),
      });
    }
  }

  /** Шаг 5: списание захолдированного после подтверждения рестораном (PAY-2). */
  private async capture(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;
    if (order.isTerminal) return this.drop(entry, "заказ уже завершён");
    if (saga.facts.paymentCaptured) {
      return this.completeWith(entry, loaded, now, this.courierFollowUp(loaded, now));
    }

    const request = { orderId: order.id, idempotencyKey: `${order.id}:capture` };
    const started = new Date();
    try {
      const result = await this.payment.capture(request);
      saga.record({ paymentCaptured: true, capturedAmount: result.amount });
      const step = this.step(entry, started, "SUCCEEDED", request, result);
      await this.committer.commit(loaded, now, {
        completeEntryId: entry.id,
        steps: [step],
        schedule: this.courierFollowUp(loaded, now),
      });
      return "completed";
    } catch (error) {
      // Отказ на списании после подтверждения — демонстрационный сценарий
      // защиты: отзыв заказа у ресторана, снятие холда, отмена «техническая».
      return this.onForwardFailure(entry, loaded, now, started, error, {
        attempts: this.settings.captureAttempts,
        giveUp: () => {
          const text = `не удалось списать оплату: ${errorText(error)}`;
          // Заказ уже у курьера: отменить его может только оператор.
          if (order.status === "IN_TRANSIT") order.flagAttention(text, now);
          else order.cancel(SYSTEM, "TECHNICAL", text, now);
        },
      });
    }
  }

  /** Шаг 6: запрос курьера. Еда уже готовится — шаг не сдаётся, а зовёт оператора. */
  private async requestCourier(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;
    if (order.isTerminal || saga.facts.courierRequested) {
      return this.drop(entry, "курьер уже вызван или заказ завершён");
    }
    const pickup = order.pickup;
    if (!pickup) {
      order.flagAttention(
        "у ресторана не указана точка выдачи: курьера нужно вызвать вручную",
        now,
      );
      await this.committer.commit(loaded, now, { completeEntryId: entry.id });
      return "completed";
    }

    const cookingMinutes = order.expectedCookingMin ?? 0;
    const readyAt = new Date((order.confirmedAt ?? now).getTime() + cookingMinutes * 60_000);
    const request = {
      orderId: order.id,
      restaurantId: order.restaurantId,
      idempotencyKey: `${order.id}:courier:${saga.facts.courierSeq}`,
      pickup,
      dropoff: order.location,
      readyAt: readyAt.toISOString(),
    };
    const started = new Date();
    try {
      const result = await this.delivery.requestCourier(request);
      saga.record({ courierRequested: true, deliveryId: result.deliveryId });
      saga.at("AWAIT_DELIVERY");
      await this.committer.commit(loaded, now, {
        completeEntryId: entry.id,
        steps: [this.step(entry, started, "SUCCEEDED", { readyAt: request.readyAt }, result)],
      });
      return "completed";
    } catch (error) {
      return this.onPersistentFailure(entry, loaded, now, started, error, "доставка недоступна");
    }
  }

  /* ─────────────── Компенсации ─────────────── */

  /** Снятие холда — компенсация шага 3. */
  private async voidPayment(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;
    if (!saga.pendingCompensations().void) return this.finishIfDone(entry, loaded, now);

    const request = {
      orderId: order.id,
      idempotencyKey: `${order.id}:void:${saga.facts.voidSeq}`,
    };
    const started = new Date();
    try {
      const result = await this.payment.void(request);
      // Платёжный сервис — источник истины: если снимать было нечего,
      // холда нет, и компенсация тоже выполнена.
      saga.record({
        paymentVoided: result.voided || saga.facts.paymentAuthorized,
        defensiveVoidPending: false,
      });
      return this.finishCompensation(
        entry,
        loaded,
        now,
        this.step(entry, started, "SUCCEEDED", request, result),
      );
    } catch (error) {
      if (!isRetryable(error)) {
        // Снять холд нельзя — значит, деньги уже списаны: компенсация
        // меняется на возврат списанного.
        saga.record({
          paymentCaptured: true,
          capturedAmount: saga.facts.capturedAmount || order.amounts.total,
          defensiveVoidPending: false,
        });
        const step = this.step(entry, started, "FAILED", request, undefined, error);
        await this.committer.commit(loaded, now, {
          completeEntryId: entry.id,
          steps: [step],
          schedule: this.workflow.compensations(saga, now),
        });
        return "completed";
      }
      return this.onPersistentFailure(entry, loaded, now, started, error, "не удаётся снять холд");
    }
  }

  /** Возврат списанного — компенсация шага 5 (PAY-3, PAY-6). */
  private async refund(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;
    const amount = saga.pendingCompensations().refund;
    if (amount === 0) return this.finishIfDone(entry, loaded, now);

    const request = {
      orderId: order.id,
      idempotencyKey: `${order.id}:refund:${saga.facts.refundSeq}`,
      amount,
    };
    const started = new Date();
    try {
      const result = await this.payment.refund(request);
      saga.record({ refundedAmount: result.refundedTotal });
      return this.finishCompensation(
        entry,
        loaded,
        now,
        this.step(entry, started, "SUCCEEDED", request, result),
      );
    } catch (error) {
      return this.onPersistentFailure(
        entry,
        loaded,
        now,
        started,
        error,
        "не удаётся вернуть деньги",
      );
    }
  }

  /** Освобождение курьера — компенсация шага 6. */
  private async releaseCourier(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order, saga } = loaded;
    if (!saga.pendingCompensations().releaseCourier) return this.finishIfDone(entry, loaded, now);

    const request = { orderId: order.id, idempotencyKey: `${order.id}:release` };
    const started = new Date();
    try {
      const result = await this.delivery.releaseCourier(request);
      saga.record({ courierReleased: true });
      return this.finishCompensation(
        entry,
        loaded,
        now,
        this.step(entry, started, "SUCCEEDED", request, result),
      );
    } catch (error) {
      return this.onPersistentFailure(
        entry,
        loaded,
        now,
        started,
        error,
        "не удаётся освободить курьера",
      );
    }
  }

  /* ─────────────── Сроки статусов (REL-6) ─────────────── */

  private async onTimeout(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    const { order } = loaded;
    const status = entry.type.slice("TIMEOUT:".length) as OrderStatus;
    const rule = TIMEOUT_TEXT[status];
    if (order.status !== status || !rule) return this.drop(entry, "статус уже сменился");

    if (rule.action === "cancel") order.cancel(SYSTEM, "TIMEOUT", rule.text, now);
    else order.flagAttention(rule.text, now);
    await this.committer.commit(loaded, now, { completeEntryId: entry.id });
    return "completed";
  }

  /* ─────────────── Общие правила ─────────────── */

  /** Прямой шаг: повтор при временном отказе, после исчерпания попыток — отмена и компенсации. */
  private async onForwardFailure(
    entry: ClaimedEntry,
    loaded: LoadedOrder,
    now: Date,
    started: Date,
    error: unknown,
    policy: { attempts: number; giveUp: () => void },
  ): Promise<RunOutcome> {
    const step = this.step(entry, started, "FAILED", undefined, undefined, error);
    if (isRetryable(error) && entry.attempt < policy.attempts) {
      await this.queue.retryLater(entry, this.nextAttemptAt(entry, now), errorText(error), step);
      return "retry";
    }
    policy.giveUp();
    await this.committer.commit(loaded, now, { completeEntryId: entry.id, steps: [step] });
    return "completed";
  }

  /**
   * Шаг, который нельзя бросить: компенсация или вызов курьера к готовящейся еде.
   * Повторяется всегда; после нескольких неудач заказ попадает к оператору.
   */
  private async onPersistentFailure(
    entry: ClaimedEntry,
    loaded: LoadedOrder,
    now: Date,
    started: Date,
    error: unknown,
    problem: string,
  ): Promise<RunOutcome> {
    const step = this.step(entry, started, "FAILED", undefined, undefined, error);
    if (!isRetryable(error) && entry.type === SAGA_STEPS.requestCourier) {
      // Отказ, который повтором не исправить: решает оператор.
      loaded.order.flagAttention(`${problem}: ${errorText(error)}`, now);
      await this.committer.commit(loaded, now, { completeEntryId: entry.id, steps: [step] });
      return "completed";
    }
    if (entry.attempt === this.settings.attentionAfterAttempts) {
      loaded.order.flagAttention(`${problem}: ${errorText(error)}`, now);
      await this.committer.commit(loaded, now);
    }
    await this.queue.retryLater(entry, this.nextAttemptAt(entry, now), errorText(error), step);
    return "retry";
  }

  private async finishCompensation(
    entry: ClaimedEntry,
    loaded: LoadedOrder,
    now: Date,
    step: SagaStepRecord,
  ): Promise<RunOutcome> {
    if (loaded.saga.fullyCompensated && loaded.order.isTerminal) loaded.saga.finishCompensation();
    await this.committer.commit(loaded, now, { completeEntryId: entry.id, steps: [step] });
    return "completed";
  }

  private async finishIfDone(entry: ClaimedEntry, loaded: LoadedOrder, now: Date) {
    if (loaded.saga.fullyCompensated && loaded.order.isTerminal) loaded.saga.finishCompensation();
    await this.committer.commit(loaded, now, { completeEntryId: entry.id });
    return "completed" as const;
  }

  private async completeWith(
    entry: ClaimedEntry,
    loaded: LoadedOrder,
    now: Date,
    schedule: CommitOptions["schedule"],
  ): Promise<RunOutcome> {
    await this.committer.commit(loaded, now, {
      completeEntryId: entry.id,
      ...(schedule ? { schedule } : {}),
    });
    return "completed";
  }

  private async drop(entry: ClaimedEntry, reason: string): Promise<RunOutcome> {
    await this.queue.discard(entry, reason);
    return "discarded";
  }

  /** После списания — вызов курьера, если он ещё не вызван. */
  private courierFollowUp({ order, saga }: LoadedOrder, now: Date) {
    if (saga.facts.courierRequested || isOrderPastCourierRequest(order)) return [];
    saga.at(SAGA_STEPS.requestCourier);
    saga.nextSeq("courierSeq");
    return [{ type: SAGA_STEPS.requestCourier, fireAt: now }];
  }

  private nextAttemptAt(entry: ClaimedEntry, now: Date): Date {
    const { retryBaseMs, retryMaxMs } = this.settings;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, entry.attempt - 1));
    return new Date(now.getTime() + delay);
  }

  private step(
    entry: ClaimedEntry,
    startedAt: Date,
    status: "SUCCEEDED" | "FAILED",
    request?: unknown,
    response?: unknown,
    error?: unknown,
  ): SagaStepRecord {
    return {
      step: entry.type,
      isCompensation: COMPENSATIONS.has(entry.type),
      status,
      attempt: entry.attempt,
      ...(request !== undefined ? { request } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(error !== undefined ? { error: errorText(error) } : {}),
      startedAt,
      finishedAt: new Date(),
    };
  }
}

function isOrderPastCourierRequest(order: Order): boolean {
  return order.isTerminal || order.status === "IN_TRANSIT";
}
