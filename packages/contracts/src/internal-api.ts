/**
 * Внутренние синхронные контракты (внутренний HTTP).
 *
 * Синхронный вызов допустим только там, где без ответа нельзя продолжить
 * операцию. Таких вызовов намеренно мало, и все они исходят от оркестратора
 * саги в `order`. Типы общие для вызывающего и вызываемого: изменение поля
 * у одной стороны ломает сборку другой, а не работу системы.
 *
 * Каждая изменяющая операция несёт ключ идемпотентности: оркестратор
 * повторяет вызовы после сбоев, и получатель обязан узнать повтор,
 * а не выполнить операцию второй раз (PAY-4).
 */

/* ─────────────── catalog ─────────────── */

/** `POST /restaurants/:restaurantId/validate-cart` — серверный снимок цен (ORD-2, CART-3). */
export interface ValidateCartRequest {
  latitude: number;
  longitude: number;
  items: Array<{
    itemId: string;
    quantity: number;
    selections?: Array<{ groupId: string; optionIds: string[] }>;
  }>;
}

export interface ValidatedCartLine {
  itemId: string;
  name: string;
  basePrice: number;
  optionsDelta: number;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  chosenOptions: Array<{ groupId: string; optionId: string; name: string; priceDelta: number }>;
}

export interface ValidateCartResponse {
  restaurantId: string;
  zoneId: string;
  lines: ValidatedCartLine[];
  itemsAmount: number;
  deliveryFee: number;
  total: number;
  /** Точка выдачи заказа курьеру — нужна доставке для подбора и маршрута. */
  pickup: { latitude: number; longitude: number } | null;
  validatedAt: string;
}

/* ─────────────── payment ─────────────── */

export const PAYMENT_API = {
  authorize: "/payments/authorize",
  capture: "/payments/capture",
  void: "/payments/void",
  refund: "/payments/refund",
} as const;

export interface PaymentCommand {
  orderId: string;
  idempotencyKey: string;
}

export interface AuthorizePaymentRequest extends PaymentCommand {
  customerId: string;
  amount: number;
  currency: "RUB";
}

/**
 * Отказ банка — штатный исход, а не ошибка вызова: повторять его бессмысленно,
 * поэтому он приходит в ответе со статусом `DECLINED`, а не кодом 5xx.
 */
export interface AuthorizePaymentResponse {
  paymentId: string;
  status: "AUTHORIZED" | "DECLINED";
  declineReason?: string;
}

export type CapturePaymentRequest = PaymentCommand;

export interface CapturePaymentResponse {
  paymentId: string;
  status: "CAPTURED";
  amount: number;
}

/** Снятие холда. Безопасно и без холда: тогда `voided: false`. */
export type VoidPaymentRequest = PaymentCommand;

export interface VoidPaymentResponse {
  paymentId: string | null;
  voided: boolean;
}

export interface RefundPaymentRequest extends PaymentCommand {
  /** Сумма возврата в копейках: меньше списанного — частичный возврат (PAY-6). */
  amount: number;
}

export interface RefundPaymentResponse {
  paymentId: string;
  status: "REFUNDED" | "PARTIALLY_REFUNDED";
  refundedTotal: number;
}

/* ─────────────── delivery ─────────────── */

export const DELIVERY_API = {
  request: "/deliveries",
  release: "/deliveries/release",
} as const;

export interface RequestCourierRequest {
  orderId: string;
  restaurantId: string;
  idempotencyKey: string;
  pickup: { latitude: number; longitude: number };
  dropoff: { latitude: number; longitude: number };
  /** Когда заказ будет готов — курьера нет смысла звать раньше. */
  readyAt: string;
  /** Клиент заказа: только ему доставка показывает позицию курьера (SEC-7). */
  customerId?: string;
}

export interface RequestCourierResponse {
  deliveryId: string;
  status: "PENDING" | "ASSIGNED";
}

/** Освобождение курьера — компенсация шага саги. Безопасно и без доставки. */
export interface ReleaseCourierRequest {
  orderId: string;
  idempotencyKey: string;
}

export interface ReleaseCourierResponse {
  released: boolean;
}
