import {
  PAYMENT_EVENT_TYPES,
  type PaymentAuthorizedPayload,
  type PaymentCapturedPayload,
  type PaymentFailedPayload,
  type PaymentRefundedPayload,
  type PaymentVoidedPayload,
} from "@food-delivery/contracts";
import { createEvent, getContext, getCorrelationId, type DomainEvent } from "@food-delivery/shared";
import type { Payment } from "../domain/payment";

const AGGREGATE = "Payment";

/**
 * События платежа — топик `payment.events`.
 *
 * Агрегат — платёж, но ключ партиции — заказ (`partitionKey` в заголовках
 * исходящего сообщения): события одного заказа должны приходить в `order`
 * по порядку, а у заказа может быть несколько платежей.
 */
function make<T>(payment: Payment, eventType: string, payload: T, at: Date): DomainEvent<T> {
  const context = getContext();
  return createEvent<T>({
    eventType,
    aggregateType: AGGREGATE,
    aggregateId: payment.id,
    payload,
    correlationId: getCorrelationId(),
    ...(context?.causationId ? { causationId: context.causationId } : {}),
    occurredAt: at,
  });
}

const base = (payment: Payment) => ({
  orderId: payment.snapshot.orderId,
  paymentId: payment.id,
});

export const paymentEvents = {
  authorized: (payment: Payment, at: Date) =>
    make<PaymentAuthorizedPayload>(
      payment,
      PAYMENT_EVENT_TYPES.authorized,
      { ...base(payment), amount: payment.snapshot.amount },
      at,
    ),
  captured: (payment: Payment, at: Date) =>
    make<PaymentCapturedPayload>(
      payment,
      PAYMENT_EVENT_TYPES.captured,
      { ...base(payment), amount: payment.snapshot.amount },
      at,
    ),
  voided: (payment: Payment, at: Date) =>
    make<PaymentVoidedPayload>(
      payment,
      PAYMENT_EVENT_TYPES.voided,
      { ...base(payment), amount: payment.snapshot.amount },
      at,
    ),
  refunded: (payment: Payment, amount: number, at: Date) =>
    make<PaymentRefundedPayload>(
      payment,
      PAYMENT_EVENT_TYPES.refunded,
      { ...base(payment), amount, refundedTotal: payment.snapshot.refundedAmount },
      at,
    ),
  failed: (
    payment: Payment,
    operation: PaymentFailedPayload["operation"],
    reason: string,
    at: Date,
  ) =>
    make<PaymentFailedPayload>(
      payment,
      PAYMENT_EVENT_TYPES.failed,
      { ...base(payment), operation, reason },
      at,
    ),
};
