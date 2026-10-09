/**
 * События платежей — топик `payment.events`, ключ партиции `orderId`.
 *
 * Синхронный ответ на вызов платёжной операции — основной путь: оркестратору
 * результат нужен сразу. События — страховка на случай, когда ответ потерян:
 * вызов закончился таймаутом, а холд у провайдера прошёл. Пришедший позже
 * `PaymentAuthorized` доводит такой заказ до согласованного состояния.
 */

export const PAYMENT_EVENT_TYPES = {
  authorized: "PaymentAuthorized",
  captured: "PaymentCaptured",
  voided: "PaymentVoided",
  refunded: "PaymentRefunded",
  failed: "PaymentFailed",
} as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[keyof typeof PAYMENT_EVENT_TYPES];

export interface PaymentEventBase {
  orderId: string;
  paymentId: string;
}

export interface PaymentAuthorizedPayload extends PaymentEventBase {
  amount: number;
}

export interface PaymentCapturedPayload extends PaymentEventBase {
  amount: number;
}

export interface PaymentVoidedPayload extends PaymentEventBase {
  amount: number;
}

export interface PaymentRefundedPayload extends PaymentEventBase {
  amount: number;
  /** Всего возвращено по платежу, включая эту операцию. */
  refundedTotal: number;
}

export interface PaymentFailedPayload extends PaymentEventBase {
  operation: "AUTHORIZE" | "CAPTURE" | "VOID" | "REFUND";
  reason: string;
}
