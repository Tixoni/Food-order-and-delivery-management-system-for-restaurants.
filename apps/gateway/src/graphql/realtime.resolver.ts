import { Args, ID, Resolver, Subscription } from "@nestjs/graphql";
import { ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { DeliveryClient } from "../delivery/delivery.client";
import { OrderClient } from "../order/order.client";
import { EventHub, channels } from "../realtime/event-hub";
import { CourierPositionUpdate, CourierSignal, OrderUpdate } from "./courier.models";
import { AccessToken, GqlUser } from "./gql.decorators";
import { restaurantOf } from "./order.resolver";

/** Событие отдаётся подписчику как есть — без обёртки по имени поля. */
const asIs = (payload: unknown) => payload;

/**
 * Подписки реального времени по WebSocket (graphql-ws): статус заказа,
 * позиция курьера, очередь кухни, предложения курьеру. Заменяют опрос.
 *
 * Права проверяются при подписке и тем же способом, что и при чтении:
 * подписаться на заказ можно, только если сервис заказов отдаёт этот заказ
 * пользователю; на позицию курьера — только если её отдаёт сервис доставки
 * (SEC-7). Шлюз прав не придумывает, он спрашивает владельцев данных.
 */
@Resolver()
export class RealtimeResolver {
  constructor(
    private readonly hub: EventHub,
    private readonly orders: OrderClient,
    private readonly delivery: DeliveryClient,
  ) {}

  /** TRK-1, NTF-1: смена статуса заказа. */
  @Subscription(() => OrderUpdate, { resolve: asIs, description: "Статус заказа изменился" })
  async orderUpdated(
    @Args("orderId", { type: () => ID }) orderId: string,
    @AccessToken() token?: string,
  ) {
    await this.orders.get(token, orderId);
    return this.hub.listen<OrderUpdate>(channels.order(orderId));
  }

  /** TRK-2: новая позиция курьера заказа (PERF-3 ≤ 2 с). */
  @Roles(ROLES.client, ROLES.operator, ROLES.admin)
  @Subscription(() => CourierPositionUpdate, { resolve: asIs, description: "Позиция курьера" })
  async courierPositionUpdated(
    @Args("orderId", { type: () => ID }) orderId: string,
    @AccessToken() token?: string,
  ) {
    await this.delivery.position(token, orderId);
    return this.hub.listen<CourierPositionUpdate>(channels.position(orderId));
  }

  /** KIT-1: очередь кухни изменилась — новый заказ, отмена, курьер забрал. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Subscription(() => OrderUpdate, { resolve: asIs, description: "Очередь кухни изменилась" })
  kitchenQueueChanged(
    @Args("restaurantId", { type: () => ID, nullable: true }) restaurantId?: string,
    @GqlUser() user?: AuthenticatedUser,
  ) {
    return this.hub.listen<OrderUpdate>(channels.kitchen(restaurantOf(user, restaurantId)));
  }

  /** DLV-4: курьеру предложили заказ или доставка изменилась — перечитать экран. */
  @Roles(ROLES.courier)
  @Subscription(() => CourierSignal, { resolve: asIs, description: "Событие для курьера" })
  async courierUpdated(@AccessToken() token?: string) {
    const { courier } = await this.delivery.dashboard(token);
    return this.hub.listen<CourierSignal>(channels.courier(courier.id));
  }
}
