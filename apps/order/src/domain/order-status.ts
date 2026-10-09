/**
 * Конечный автомат заказа (ORD-3).
 *
 * Таблица переходов — единственный источник правды о том, что с заказом
 * можно сделать и кто это может. Перехода, которого нет в таблице,
 * не существует: попытка отклоняется. Без явной таблицы правила расползаются
 * по условным операторам в десятке мест и рано или поздно расходятся.
 *
 * Решения, принятые при реализации (см. заметку «Микросервис - Order», раздел 11):
 *
 *   «Забран» и «в пути» — один статус IN_TRANSIT. Доставка сообщает о вручении
 *   курьеру одним событием; второго источника для отдельного перехода нет.
 *
 *   PAID и READY — переходные: заказ проходит их в той же транзакции, что
 *   и следующий шаг, и в них не задерживается. Им не нужен таймер — они
 *   не могут «зависнуть» (REL-6). В истории и в событиях они видны.
 */

export const ORDER_STATUSES = [
  "CREATED",
  "PENDING_PAYMENT",
  "PAID",
  "AWAITING_RESTAURANT",
  "COOKING",
  "READY",
  "ASSIGNING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(["DELIVERED", "CANCELLED"]);

/** Статусы, в которых заказ не задерживается: следующий шаг выполняется той же транзакцией. */
export const TRANSIENT_STATUSES: ReadonlySet<OrderStatus> = new Set(["PAID", "READY"]);

/** Кто выполняет переход. Записывается в историю (ADM-3). */
export type ActorType = "CUSTOMER" | "RESTAURANT" | "COURIER" | "OPERATOR" | "SYSTEM";

export const CANCEL_REASONS = [
  "CUSTOMER",
  "RESTAURANT",
  "TIMEOUT",
  "OPERATOR",
  "TECHNICAL",
  "PAYMENT_FAILED",
] as const;

/**
 * Причина отмены. Один терминальный статус с причиной, а не шесть статусов:
 * переходы у всех вариантов отмены одинаковы, различаются только причина
 * и сценарий возврата средств.
 */
export type CancelReason = (typeof CANCEL_REASONS)[number];

interface TransitionRule {
  from: OrderStatus;
  to: OrderStatus;
  actors: readonly ActorType[];
}

/** Отмены до начала готовки: клиент вправе отменить сам (ORD-5). */
const EARLY: readonly OrderStatus[] = ["CREATED", "PENDING_PAYMENT", "PAID"];
/** После начала готовки отменить может только оператор (ORD-6) или система при сбое. */
const LATE: readonly OrderStatus[] = ["COOKING", "READY", "ASSIGNING_COURIER"];

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: "CREATED", to: "PENDING_PAYMENT", actors: ["SYSTEM"] },
  { from: "PENDING_PAYMENT", to: "PAID", actors: ["SYSTEM"] },
  { from: "PAID", to: "AWAITING_RESTAURANT", actors: ["SYSTEM"] },
  { from: "AWAITING_RESTAURANT", to: "COOKING", actors: ["RESTAURANT"] },
  // Система отмечает готовность сама, если курьер забрал заказ раньше,
  // чем кухня нажала «готово»: факт вручения сильнее забытой кнопки.
  { from: "COOKING", to: "READY", actors: ["RESTAURANT", "SYSTEM"] },
  { from: "READY", to: "ASSIGNING_COURIER", actors: ["SYSTEM"] },
  { from: "ASSIGNING_COURIER", to: "IN_TRANSIT", actors: ["COURIER"] },
  { from: "IN_TRANSIT", to: "DELIVERED", actors: ["COURIER"] },

  ...EARLY.map((from) => ({
    from,
    to: "CANCELLED" as const,
    actors: ["CUSTOMER", "SYSTEM", "OPERATOR"] as const,
  })),
  {
    from: "AWAITING_RESTAURANT",
    to: "CANCELLED",
    actors: ["CUSTOMER", "RESTAURANT", "SYSTEM", "OPERATOR"],
  },
  ...LATE.map((from) => ({
    from,
    to: "CANCELLED" as const,
    actors: ["OPERATOR", "SYSTEM"] as const,
  })),
  // Заказ уже у курьера: отменить может только оператор (курьер пропал, клиент не вышел).
  { from: "IN_TRANSIT", to: "CANCELLED", actors: ["OPERATOR"] },
];

export function isTransitionAllowed(from: OrderStatus, to: OrderStatus, actor: ActorType) {
  return TRANSITIONS.some(
    (rule) => rule.from === from && rule.to === to && rule.actors.includes(actor),
  );
}

/** Какие причины отмены вправе указать актор. Клиент не может отменить «по вине ресторана». */
export const CANCEL_REASONS_BY_ACTOR: Readonly<Record<ActorType, readonly CancelReason[]>> = {
  CUSTOMER: ["CUSTOMER"],
  RESTAURANT: ["RESTAURANT"],
  OPERATOR: ["OPERATOR"],
  SYSTEM: ["TIMEOUT", "TECHNICAL", "PAYMENT_FAILED"],
  COURIER: [],
};

/** Ресторан уже видел заказ — при отмене его нужно отозвать (OrderRecalled). */
export function restaurantSawOrder(status: OrderStatus): boolean {
  return ["AWAITING_RESTAURANT", "COOKING", "READY", "ASSIGNING_COURIER"].includes(status);
}
