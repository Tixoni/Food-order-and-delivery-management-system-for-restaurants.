import type { DomainEvent } from "@food-delivery/shared";
import { FORWARD_STEPS, SAGA_STEPS, type CheckoutSaga } from "../../domain/checkout-saga";
import type { Order, StatusChange } from "../../domain/order";
import { ORDER_STATUSES } from "../../domain/order-status";
import { DEFAULT_TIMEOUTS, timeoutFor, type StatusTimeouts } from "../../domain/order-timeouts";
import type { ScheduledEntry } from "../ports/order.repository";
import { eventsFor } from "./order-events";

/** Имена всех таймеров статусов: при любом переходе старый срок снимается. */
export const ALL_TIMEOUTS: readonly string[] = ORDER_STATUSES.map((status) => `TIMEOUT:${status}`);

export interface WorkflowPlan {
  events: DomainEvent[];
  schedule: ScheduledEntry[];
  cancel: string[];
}

export interface PlanOptions {
  /** Оценка времени в пути от доставки — для срока статуса «в пути». */
  etaMinutes?: number | null;
  /**
   * Исход холдирования известен: банк отказал. Снятие холда «на всякий случай»
   * при отмене не нужно — холда точно нет.
   */
  holdOutcomeKnown?: boolean;
}

/**
 * Что следует из переходов заказа: события, сроки статусов, шаги саги,
 * компенсации.
 *
 * Одно место для всех сценариев — команд пользователя, шагов саги,
 * событий участников. Если бы каждый сценарий решал это сам, правила
 * («после отмены снять холд», «у каждого статуса есть срок») рано или
 * поздно разошлись бы между ними.
 */
export class OrderWorkflow {
  constructor(private readonly timeouts: StatusTimeouts = DEFAULT_TIMEOUTS) {}

  plan(
    order: Order,
    saga: CheckoutSaga,
    changes: readonly StatusChange[],
    now: Date,
    options: PlanOptions = {},
  ): WorkflowPlan {
    const schedule: ScheduledEntry[] = [];
    const cancel: string[] = [];
    const reached = new Set(changes.map((change) => change.to));
    let respondBy: Date | undefined;

    // REL-6: при каждом переходе старый срок снимается, новый ставится.
    if (changes.length > 0) {
      cancel.push(...ALL_TIMEOUTS);
      const timeout = timeoutFor(
        order.status,
        now,
        { expectedCookingMin: order.expectedCookingMin, etaMinutes: options.etaMinutes ?? null },
        this.timeouts,
      );
      if (timeout) {
        schedule.push({ type: timeout.type, fireAt: timeout.fireAt });
        if (timeout.type === "TIMEOUT:AWAITING_RESTAURANT") respondBy = timeout.fireAt;
      }
    }

    // Прямые шаги саги — их выполняет фоновый исполнитель, а не запрос
    // пользователя: запрос не ждёт платёжный сервис, шаг переживает перезапуск.
    if (reached.has("CREATED")) {
      saga.at(SAGA_STEPS.authorizePayment);
      schedule.push({ type: SAGA_STEPS.authorizePayment, fireAt: now });
    }
    if (reached.has("PAID")) {
      // Результат мог прийти событием, пока шаг ждал повтора, — шаг больше не нужен.
      cancel.push(SAGA_STEPS.authorizePayment);
      saga.at("AWAIT_RESTAURANT");
    }
    if (reached.has("COOKING")) {
      saga.at(SAGA_STEPS.capturePayment);
      schedule.push({ type: SAGA_STEPS.capturePayment, fireAt: now });
    }

    let refundExpected = false;
    const cancellation = changes.find((change) => change.to === "CANCELLED");
    if (cancellation) {
      cancel.push(...FORWARD_STEPS);
      saga.compensate();
      const defensiveVoid =
        cancellation.from === "PENDING_PAYMENT" &&
        !options.holdOutcomeKnown &&
        !saga.facts.paymentAuthorized;
      if (defensiveVoid) saga.record({ defensiveVoidPending: true });
      const compensations = this.compensations(saga, now);
      schedule.push(...compensations);
      refundExpected = compensations.some(
        (entry) => entry.type === SAGA_STEPS.voidPayment || entry.type === SAGA_STEPS.refundPayment,
      );
      if (compensations.length === 0) saga.finishCompensation();
    }

    if (reached.has("DELIVERED")) saga.complete();

    return {
      events: eventsFor(order, changes, { respondBy, refundExpected }),
      schedule,
      cancel,
    };
  }

  /**
   * Компенсации по фактам саги. Каждая новая компенсация получает новый
   * порядковый номер — он входит в ключ идемпотентности вызова.
   */
  compensations(saga: CheckoutSaga, now: Date): ScheduledEntry[] {
    const pending = saga.pendingCompensations();
    const entries: ScheduledEntry[] = [];
    if (pending.void) {
      saga.nextSeq("voidSeq");
      entries.push({ type: SAGA_STEPS.voidPayment, fireAt: now });
    }
    if (pending.refund > 0) {
      saga.nextSeq("refundSeq");
      entries.push({ type: SAGA_STEPS.refundPayment, fireAt: now });
    }
    if (pending.releaseCourier) entries.push({ type: SAGA_STEPS.releaseCourier, fireAt: now });
    if (entries.length > 0) saga.compensate();
    return entries;
  }
}

export const ORDER_WORKFLOW = Symbol("OrderWorkflow");
