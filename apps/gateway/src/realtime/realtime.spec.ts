import { DELIVERY_EVENT_TYPES, ORDER_EVENT_TYPES } from "@food-delivery/contracts";
import { NotFoundError, createEvent } from "@food-delivery/shared";
import { MetricsService } from "@food-delivery/service-kit";
import { loadConfig } from "../config/configuration";
import type { DeliveryClient } from "../delivery/delivery.client";
import { RealtimeResolver } from "../graphql/realtime.resolver";
import type { OrderClient } from "../order/order.client";
import { EventHub, channels } from "./event-hub";
import { RealtimeEventsConsumer } from "./realtime-sources";

const event = (eventType: string, payload: Record<string, unknown>) =>
  createEvent({
    eventType,
    aggregateType: "Order",
    aggregateId: "o-1",
    correlationId: "corr",
    payload,
  });

describe("раздача событий подписчикам", () => {
  let hub: EventHub;
  let consumer: RealtimeEventsConsumer;

  beforeEach(() => {
    hub = new EventHub(new MetricsService("gateway-test"));
    consumer = new RealtimeEventsConsumer({ ...loadConfig(), logLevel: "error" }, hub);
  });

  it("смена статуса уходит подписчикам заказа и кухне ресторана", async () => {
    const order = hub.listen(channels.order("o-1"));
    const kitchen = hub.listen(channels.kitchen("r-1"));
    const other = hub.listen(channels.order("o-2"));

    consumer.dispatch(
      event(ORDER_EVENT_TYPES.statusChanged, {
        orderId: "o-1",
        restaurantId: "r-1",
        customerId: "c-1",
        orderNumber: 7,
        from: "COOKING",
        to: "READY",
        changedAt: "2026-10-12T10:00:00Z",
      }),
    );

    await expect(order.next()).resolves.toMatchObject({
      value: { orderId: "o-1", status: "READY", previousStatus: "COOKING" },
    });
    await expect(kitchen.next()).resolves.toMatchObject({ value: { status: "READY" } });
    // Чужому заказу — ничего: следующее значение ещё не пришло
    const race = await Promise.race([other.next(), Promise.resolve("ничего")]);
    expect(race).toBe("ничего");
    await other.return?.();
  });

  it("предложение курьеру уходит в канал этого курьера", async () => {
    const courier = hub.listen(channels.courier("courier-1"));

    consumer.dispatch(
      event(DELIVERY_EVENT_TYPES.courierAssigned, {
        orderId: "o-1",
        deliveryId: "d-1",
        courierId: "courier-1",
      }),
    );

    await expect(courier.next()).resolves.toMatchObject({
      value: { kind: DELIVERY_EVENT_TYPES.courierAssigned, orderId: "o-1" },
    });
  });

  it("отключение клиента снимает обработчик", async () => {
    const subscription = hub.listen(channels.position("o-1"));
    expect(hub.subscribers(channels.position("o-1"))).toBe(1);

    await subscription.return?.();

    expect(hub.subscribers(channels.position("o-1"))).toBe(0);
    await expect(subscription.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("медленному клиенту копится не больше сотни событий", async () => {
    const subscription = hub.listen<number>(channels.position("o-1"));
    for (let i = 0; i < 150; i += 1) hub.emit(channels.position("o-1"), i);

    const first = await subscription.next();
    expect(first.value).toBe(50);
    await subscription.return?.();
  });
});

describe("права на подписку (SEC-2, SEC-7)", () => {
  const foreign = () => Promise.reject(new NotFoundError("заказ не найден"));

  it("на чужой заказ и чужую позицию не подписаться: владелец данных отказал — канала нет", async () => {
    const hub = new EventHub(new MetricsService("gateway-test"));
    const orders = { get: jest.fn(foreign) } as unknown as OrderClient;
    const delivery = { position: jest.fn(foreign) } as unknown as DeliveryClient;
    const resolver = new RealtimeResolver(hub, orders, delivery);

    await expect(resolver.orderUpdated("o-1", "token")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolver.courierPositionUpdated("o-1", "token")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(hub.subscribers(channels.order("o-1"))).toBe(0);
    expect(hub.subscribers(channels.position("o-1"))).toBe(0);
  });

  it("свой заказ — проверка с токеном клиента, затем подписка", async () => {
    const hub = new EventHub(new MetricsService("gateway-test"));
    const orders = { get: jest.fn().mockResolvedValue({ id: "o-1" }) } as unknown as OrderClient;
    const resolver = new RealtimeResolver(hub, orders, {} as DeliveryClient);

    const subscription = await resolver.orderUpdated("o-1", "token");

    expect(orders.get).toHaveBeenCalledWith("token", "o-1");
    expect(hub.subscribers(channels.order("o-1"))).toBe(1);
    await subscription.return?.();
  });
});
