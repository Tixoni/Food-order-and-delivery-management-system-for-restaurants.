import {
  DELIVERY_EVENT_TYPES,
  type CourierAcceptedPayload,
  type CourierAssignedPayload,
  type CourierNotFoundPayload,
  type DeliveryCompletedPayload,
  type OrderPickedUpPayload,
} from "@food-delivery/contracts";
import { createEvent, getContext, getCorrelationId, type DomainEvent } from "@food-delivery/shared";
import type { Delivery } from "../domain/delivery";

/**
 * События доставки — топик `delivery.events`. Доставка сообщает факты,
 * переход статуса заказа выполняет `order`.
 */
function make<T>(delivery: Delivery, eventType: string, payload: T, at: Date): DomainEvent<T> {
  const context = getContext();
  return createEvent<T>({
    eventType,
    aggregateType: "Delivery",
    aggregateId: delivery.id,
    payload,
    correlationId: getCorrelationId(),
    ...(context?.causationId ? { causationId: context.causationId } : {}),
    occurredAt: at,
  });
}

const base = (delivery: Delivery) => ({
  orderId: delivery.snapshot.orderId,
  deliveryId: delivery.id,
});

export const deliveryEvents = {
  courierAssigned: (delivery: Delivery, courierId: string, at: Date) =>
    make<CourierAssignedPayload>(
      delivery,
      DELIVERY_EVENT_TYPES.courierAssigned,
      { ...base(delivery), courierId },
      at,
    ),
  courierAccepted: (delivery: Delivery, courierId: string, at: Date) =>
    make<CourierAcceptedPayload>(
      delivery,
      DELIVERY_EVENT_TYPES.courierAccepted,
      { ...base(delivery), courierId },
      at,
    ),
  courierNotFound: (delivery: Delivery, attempts: number, at: Date) =>
    make<CourierNotFoundPayload>(
      delivery,
      DELIVERY_EVENT_TYPES.courierNotFound,
      { ...base(delivery), attempts },
      at,
    ),
  pickedUp: (delivery: Delivery, courierId: string, at: Date, etaMinutes: number) =>
    make<OrderPickedUpPayload>(
      delivery,
      DELIVERY_EVENT_TYPES.orderPickedUp,
      { ...base(delivery), courierId, pickedUpAt: at.toISOString(), etaMinutes },
      at,
    ),
  completed: (delivery: Delivery, courierId: string, at: Date) =>
    make<DeliveryCompletedPayload>(
      delivery,
      DELIVERY_EVENT_TYPES.deliveryCompleted,
      { ...base(delivery), courierId, deliveredAt: at.toISOString() },
      at,
    ),
};
