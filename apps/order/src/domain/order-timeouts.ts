import type { OrderStatus } from "./order-status";

/**
 * Сроки нетерминальных статусов (REL-6).
 *
 * Инвариант: у каждого статуса, в котором заказ может задержаться, есть срок.
 * Ни один заказ не может зависнуть навсегда. Переходные статусы (PAID, READY)
 * срока не имеют: заказ в них не задерживается — см. order-status.ts.
 *
 * Два вида реакции на истечение срока:
 *   cancel — отменить заказ и вернуть деньги: ещё ничего не готовилось;
 *   alert  — позвать оператора: еда уже готовится или едет, автоматическая
 *            отмена здесь хуже ожидания.
 */
export interface StatusTimeouts {
  createdMinutes: number;
  pendingPaymentMinutes: number;
  /** KIT-5: ресторан не ответил — автоотмена. */
  awaitingRestaurantMinutes: number;
  /** Срок готовки — заявленное время, умноженное на этот коэффициент. */
  cookingOverrunFactor: number;
  assigningCourierMinutes: number;
  /** Срок в пути, если доставка не сообщила оценку времени. */
  inTransitDefaultMinutes: number;
}

export const DEFAULT_TIMEOUTS: StatusTimeouts = {
  createdMinutes: 5,
  pendingPaymentMinutes: 10,
  awaitingRestaurantMinutes: 3,
  cookingOverrunFactor: 2,
  assigningCourierMinutes: 10,
  inTransitDefaultMinutes: 60,
};

export interface TimeoutPolicy {
  /** Имя таймера: по нему таймер снимается при выходе из статуса. */
  type: `TIMEOUT:${OrderStatus}`;
  fireAt: Date;
  action: "cancel" | "alert";
}

export interface TimeoutContext {
  /** Заявленное кухней время готовки, минуты. */
  expectedCookingMin: number | null;
  /** Оценка времени в пути от доставки, минуты. */
  etaMinutes?: number | null;
}

const minutes = (at: Date, value: number) => new Date(at.getTime() + value * 60_000);

/** Срок для статуса, в который заказ только что перешёл, или null для статусов без срока. */
export function timeoutFor(
  status: OrderStatus,
  enteredAt: Date,
  context: TimeoutContext,
  limits: StatusTimeouts = DEFAULT_TIMEOUTS,
): TimeoutPolicy | null {
  switch (status) {
    case "CREATED":
      return {
        type: "TIMEOUT:CREATED",
        fireAt: minutes(enteredAt, limits.createdMinutes),
        action: "cancel",
      };
    case "PENDING_PAYMENT":
      return {
        type: "TIMEOUT:PENDING_PAYMENT",
        fireAt: minutes(enteredAt, limits.pendingPaymentMinutes),
        action: "cancel",
      };
    case "AWAITING_RESTAURANT":
      return {
        type: "TIMEOUT:AWAITING_RESTAURANT",
        fireAt: minutes(enteredAt, limits.awaitingRestaurantMinutes),
        action: "cancel",
      };
    case "COOKING":
      return {
        type: "TIMEOUT:COOKING",
        fireAt: minutes(
          enteredAt,
          (context.expectedCookingMin ?? 30) * limits.cookingOverrunFactor,
        ),
        action: "alert",
      };
    case "ASSIGNING_COURIER":
      return {
        type: "TIMEOUT:ASSIGNING_COURIER",
        fireAt: minutes(enteredAt, limits.assigningCourierMinutes),
        action: "alert",
      };
    case "IN_TRANSIT":
      return {
        type: "TIMEOUT:IN_TRANSIT",
        fireAt: minutes(
          enteredAt,
          context.etaMinutes ? context.etaMinutes * 2 : limits.inTransitDefaultMinutes,
        ),
        action: "alert",
      };
    default:
      return null;
  }
}
