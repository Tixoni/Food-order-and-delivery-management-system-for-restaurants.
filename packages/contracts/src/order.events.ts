/**
 * События заказа — топик `order.events`.
 *
 * Ключ партиции — `orderId`: все события одного заказа попадают в одну
 * партицию и читаются по порядку. Без этого потребитель увидит «доставлен»
 * раньше «готовится» (см. заметку «11 — Контракты API и события»).
 *
 * Два вида событий. `OrderStatusChanged` публикуется на каждый переход —
 * его достаточно экрану отслеживания (TRK-1). Остальные — смысловые события
 * ключевых моментов с данными, нужными конкретным потребителям: кухне нужен
 * состав заказа, уведомлениям — причина отмены.
 */

export const ORDER_EVENT_TYPES = {
  statusChanged: "OrderStatusChanged",
  placed: "OrderPlaced",
  paid: "OrderPaid",
  confirmed: "OrderConfirmed",
  ready: "OrderReady",
  recalled: "OrderRecalled",
  cancelled: "OrderCancelled",
  delivered: "OrderDelivered",
} as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[keyof typeof ORDER_EVENT_TYPES];

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

export type OrderStatusName = (typeof ORDER_STATUSES)[number];

export const CANCEL_REASONS = [
  "CUSTOMER",
  "RESTAURANT",
  "TIMEOUT",
  "OPERATOR",
  "TECHNICAL",
  "PAYMENT_FAILED",
] as const;

export type CancelReasonName = (typeof CANCEL_REASONS)[number];

/** Общая часть всех событий заказа. */
export interface OrderEventBase {
  orderId: string;
  orderNumber: number;
  restaurantId: string;
  customerId: string;
}

/** Любой переход статуса (TRK-1). */
export interface OrderStatusChangedPayload extends OrderEventBase {
  from: OrderStatusName | null;
  to: OrderStatusName;
  changedAt: string;
}

/** Заказ оплачен и отправлен ресторану — с составом для экрана кухни (KIT-1). */
export interface OrderPlacedPayload extends OrderEventBase {
  items: Array<{ name: string; quantity: number; options: string[] }>;
  totalAmount: number;
  comment: string | null;
  /** Срок, до которого ресторан должен ответить (KIT-5). */
  respondBy: string;
}

export interface OrderPaidPayload extends OrderEventBase {
  amount: number;
}

/** Ресторан принял заказ и назвал время готовки (KIT-2). */
export interface OrderConfirmedPayload extends OrderEventBase {
  cookingMinutes: number;
  expectedReadyAt: string;
}

export interface OrderReadyPayload extends OrderEventBase {
  readyAt: string;
}

/** Компенсация шага саги: заказ отозван у ресторана, готовить не нужно. */
export interface OrderRecalledPayload extends OrderEventBase {
  reason: string;
}

export interface OrderCancelledPayload extends OrderEventBase {
  cancelReason: CancelReasonName;
  /** Текст для людей; у системных отмен формируется самой системой. */
  comment: string | null;
  /** Были ли средства захолдированы или списаны — уведомлению важно сказать о возврате. */
  refundExpected: boolean;
}

export interface OrderDeliveredPayload extends OrderEventBase {
  deliveredAt: string;
}
