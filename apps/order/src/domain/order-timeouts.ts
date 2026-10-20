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

interface TimeoutRule {
  action: "cancel" | "alert";
  /** Что произошло — в причину отмены или в очередь оператора. */
  text: string;
  minutes: (limits: StatusTimeouts, context: TimeoutContext) => number;
}

/**
 * Сроки и реакции по статусам — одна таблица на постановку срока и на его
 * истечение: исполнитель саги берёт реакцию отсюда же, а не держит свою копию.
 */
export const TIMEOUT_RULES: Partial<Record<OrderStatus, TimeoutRule>> = {
  CREATED: {
    action: "cancel",
    text: "заказ не перешёл к оплате вовремя",
    minutes: (limits) => limits.createdMinutes,
  },
  PENDING_PAYMENT: {
    action: "cancel",
    text: "оплата не завершилась вовремя",
    minutes: (limits) => limits.pendingPaymentMinutes,
  },
  AWAITING_RESTAURANT: {
    action: "cancel",
    text: "ресторан не подтвердил заказ вовремя",
    minutes: (limits) => limits.awaitingRestaurantMinutes,
  },
  COOKING: {
    action: "alert",
    text: "готовка идёт вдвое дольше заявленного",
    minutes: (limits, context) => (context.expectedCookingMin ?? 30) * limits.cookingOverrunFactor,
  },
  ASSIGNING_COURIER: {
    action: "alert",
    text: "курьер не найден вовремя",
    minutes: (limits) => limits.assigningCourierMinutes,
  },
  IN_TRANSIT: {
    action: "alert",
    text: "доставка идёт дольше ожидаемого",
    minutes: (limits, context) =>
      context.etaMinutes ? context.etaMinutes * 2 : limits.inTransitDefaultMinutes,
  },
};

/** Срок для статуса, в который заказ только что перешёл, или null для статусов без срока. */
export function timeoutFor(
  status: OrderStatus,
  enteredAt: Date,
  context: TimeoutContext,
  limits: StatusTimeouts = DEFAULT_TIMEOUTS,
): TimeoutPolicy | null {
  const rule = TIMEOUT_RULES[status];
  if (!rule) return null;
  return {
    type: `TIMEOUT:${status}`,
    fireAt: new Date(enteredAt.getTime() + rule.minutes(limits, context) * 60_000),
    action: rule.action,
  };
}
