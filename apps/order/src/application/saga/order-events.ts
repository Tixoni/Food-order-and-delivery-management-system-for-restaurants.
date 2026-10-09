import {
  ORDER_EVENT_TYPES,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderDeliveredPayload,
  type OrderEventBase,
  type OrderPaidPayload,
  type OrderPlacedPayload,
  type OrderReadyPayload,
  type OrderRecalledPayload,
  type OrderStatusChangedPayload,
} from "@food-delivery/contracts";
import { createEvent, getContext, getCorrelationId, type DomainEvent } from "@food-delivery/shared";
import type { Order, StatusChange } from "../../domain/order";
import { restaurantSawOrder } from "../../domain/order-status";

const AGGREGATE = "order";

/**
 * События по переходам заказа.
 *
 * Строятся из списка переходов, который накопил агрегат, — поэтому событие
 * не может разойтись с фактическим статусом: нет перехода — нет события.
 * Записываются той же транзакцией, что и сам переход (REL-3).
 *
 * На каждый переход — `OrderStatusChanged` для экранов отслеживания;
 * для ключевых моментов — смысловое событие с данными для своего потребителя.
 */
export function eventsFor(
  order: Order,
  changes: readonly StatusChange[],
  options: { respondBy?: Date; refundExpected?: boolean } = {},
): DomainEvent[] {
  const snapshot = order.snapshot();
  const base: OrderEventBase = {
    orderId: order.id,
    orderNumber: snapshot.orderNumber,
    restaurantId: snapshot.restaurantId,
    customerId: snapshot.customerId,
  };
  const context = getContext();
  const make = <T>(eventType: string, payload: T, at: Date) =>
    createEvent<T>({
      eventType,
      aggregateType: AGGREGATE,
      aggregateId: order.id,
      payload,
      correlationId: getCorrelationId(),
      ...(context?.causationId ? { causationId: context.causationId } : {}),
      occurredAt: at,
    });

  const events: DomainEvent[] = [];
  for (const change of changes) {
    events.push(
      make<OrderStatusChangedPayload>(
        ORDER_EVENT_TYPES.statusChanged,
        { ...base, from: change.from, to: change.to, changedAt: change.at.toISOString() },
        change.at,
      ),
    );

    switch (change.to) {
      case "PAID":
        events.push(
          make<OrderPaidPayload>(
            ORDER_EVENT_TYPES.paid,
            { ...base, amount: snapshot.amounts.total },
            change.at,
          ),
        );
        break;
      case "AWAITING_RESTAURANT":
        events.push(
          make<OrderPlacedPayload>(
            ORDER_EVENT_TYPES.placed,
            {
              ...base,
              items: snapshot.lines.map((line) => ({
                name: line.name,
                quantity: line.quantity,
                options: line.options.map((option) => option.name),
              })),
              totalAmount: snapshot.amounts.total,
              comment: snapshot.comment,
              respondBy: (options.respondBy ?? change.at).toISOString(),
            },
            change.at,
          ),
        );
        break;
      case "COOKING":
        events.push(
          make<OrderConfirmedPayload>(
            ORDER_EVENT_TYPES.confirmed,
            {
              ...base,
              cookingMinutes: snapshot.expectedCookingMin ?? 0,
              expectedReadyAt: new Date(
                change.at.getTime() + (snapshot.expectedCookingMin ?? 0) * 60_000,
              ).toISOString(),
            },
            change.at,
          ),
        );
        break;
      case "READY":
        events.push(
          make<OrderReadyPayload>(
            ORDER_EVENT_TYPES.ready,
            { ...base, readyAt: change.at.toISOString() },
            change.at,
          ),
        );
        break;
      case "CANCELLED":
        // Ресторан уже видел заказ — его нужно отозвать: компенсация шага
        // «отправить ресторану». Иначе кухня приготовит отменённый заказ.
        if (change.from && restaurantSawOrder(change.from)) {
          events.push(
            make<OrderRecalledPayload>(
              ORDER_EVENT_TYPES.recalled,
              { ...base, reason: change.reason ?? "заказ отменён" },
              change.at,
            ),
          );
        }
        events.push(
          make<OrderCancelledPayload>(
            ORDER_EVENT_TYPES.cancelled,
            {
              ...base,
              cancelReason: snapshot.cancelReason ?? "TECHNICAL",
              comment: snapshot.cancelComment,
              refundExpected: options.refundExpected ?? false,
            },
            change.at,
          ),
        );
        break;
      case "DELIVERED":
        events.push(
          make<OrderDeliveredPayload>(
            ORDER_EVENT_TYPES.delivered,
            { ...base, deliveredAt: change.at.toISOString() },
            change.at,
          ),
        );
        break;
      default:
        break;
    }
  }
  return events;
}
