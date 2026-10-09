/**
 * События доставки — топик `delivery.events`, ключ партиции `orderId`.
 *
 * Доставка не меняет статус заказа сама: она сообщает о фактах,
 * а переход выполняет `order`. Данные принадлежат ровно одному контексту.
 */

export const DELIVERY_EVENT_TYPES = {
  courierAssigned: "CourierAssigned",
  courierAccepted: "CourierAccepted",
  courierNotFound: "CourierNotFound",
  orderPickedUp: "OrderPickedUp",
  deliveryCompleted: "DeliveryCompleted",
} as const;

export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[keyof typeof DELIVERY_EVENT_TYPES];

export interface DeliveryEventBase {
  orderId: string;
  deliveryId: string;
}

/** Курьеру предложен заказ; он ещё может отказаться (DLV-4). */
export interface CourierAssignedPayload extends DeliveryEventBase {
  courierId: string;
}

export interface CourierAcceptedPayload extends DeliveryEventBase {
  courierId: string;
}

/** Кандидаты исчерпаны: свободных курьеров рядом нет. */
export interface CourierNotFoundPayload extends DeliveryEventBase {
  attempts: number;
}

export interface OrderPickedUpPayload extends DeliveryEventBase {
  courierId: string;
  pickedUpAt: string;
  /** Оценка времени в пути по маршруту; без неё действует срок по умолчанию. */
  etaMinutes?: number;
}

/**
 * Курьер вручил заказ. Имя отличается от `OrderDelivered` намеренно:
 * факт для клиента публикует `order` после своего перехода, и у подписчика
 * обоих топиков не должно быть двух событий с одним смыслом.
 */
export interface DeliveryCompletedPayload extends DeliveryEventBase {
  courierId: string;
  deliveredAt: string;
}
