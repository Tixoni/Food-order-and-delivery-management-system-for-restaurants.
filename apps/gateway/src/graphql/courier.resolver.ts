import {
  Args,
  Context,
  Float,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "@nestjs/graphql";
import { ROLES, Roles } from "@food-delivery/service-kit";
import type { RestaurantView } from "../catalog/catalog.views";
import { DeliveryClient } from "../delivery/delivery.client";
import { Restaurant } from "./catalog.models";
import {
  CourierDashboard,
  CourierProfile,
  DeliveryTask,
  OrderCourierPosition,
} from "./courier.models";
import { AccessToken } from "./gql.decorators";
import { RestaurantLookup, type LookupContext } from "./restaurant-lookup";

/**
 * Приложение курьера (DLV-1, DLV-2, DLV-4, DLV-5) и позиция курьера
 * для клиента (TRK-2).
 *
 * Шлюз только пересылает: курьера доставка определяет по его учётной
 * записи, позицию показывает только клиенту заказа (SEC-7). Название
 * ресторана в доставке — из каталога, вложенным полем.
 */
@Resolver(() => DeliveryTask)
export class CourierResolver {
  constructor(
    private readonly delivery: DeliveryClient,
    private readonly restaurants: RestaurantLookup,
  ) {}

  @Roles(ROLES.courier)
  @Query(() => CourierDashboard, { description: "Экран курьера: смена, предложение, доставка" })
  courierDashboard(@AccessToken() token?: string) {
    return this.delivery.dashboard(token);
  }

  @Roles(ROLES.courier)
  @Mutation(() => CourierProfile, { description: "На смену и со смены (DLV-1)" })
  setCourierShift(@Args("onShift") onShift: boolean, @AccessToken() token?: string) {
    return this.delivery.setShift(token, onShift);
  }

  @Roles(ROLES.courier)
  @Mutation(() => Boolean, { description: "Координата курьера — раз в 5–10 с (DLV-2)" })
  async updateCourierLocation(
    @Args("latitude", { type: () => Float }) latitude: number,
    @Args("longitude", { type: () => Float }) longitude: number,
    @Args("accuracy", { type: () => Float, nullable: true }) accuracy?: number,
    @AccessToken() token?: string,
  ) {
    const result = await this.delivery.sendLocation(token, {
      latitude,
      longitude,
      accuracy: accuracy ?? null,
    });
    return result.accepted;
  }

  @Roles(ROLES.courier)
  @Mutation(() => DeliveryTask, { description: "Принять предложение в срок (DLV-4)" })
  acceptOffer(@Args("id", { type: () => ID }) id: string, @AccessToken() token?: string) {
    return this.delivery.accept(token, id);
  }

  @Roles(ROLES.courier)
  @Mutation(() => Boolean, { description: "Отказаться — заказ уйдёт следующему курьеру" })
  async rejectOffer(@Args("id", { type: () => ID }) id: string, @AccessToken() token?: string) {
    return (await this.delivery.reject(token, id)).rejected;
  }

  @Roles(ROLES.courier)
  @Mutation(() => DeliveryTask, { description: "Забрал заказ в ресторане (DLV-5)" })
  markPickedUp(@Args("deliveryId", { type: () => ID }) id: string, @AccessToken() token?: string) {
    return this.delivery.pickedUp(token, id);
  }

  @Roles(ROLES.courier)
  @Mutation(() => DeliveryTask, { description: "Вручил заказ клиенту (DLV-5)" })
  markDelivered(@Args("deliveryId", { type: () => ID }) id: string, @AccessToken() token?: string) {
    return this.delivery.delivered(token, id);
  }

  /** TRK-2: где курьер — клиенту заказа и оператору (SEC-7 проверяет доставка). */
  @Roles(ROLES.client, ROLES.operator, ROLES.admin)
  @Query(() => OrderCourierPosition, { description: "Позиция курьера заказа (TRK-2)" })
  courierPosition(
    @Args("orderId", { type: () => ID }) orderId: string,
    @AccessToken() token?: string,
  ) {
    return this.delivery.position(token, orderId);
  }

  @ResolveField(() => Restaurant, { nullable: true })
  restaurant(
    @Parent() task: DeliveryTask,
    @Context() context: LookupContext,
  ): Promise<RestaurantView | null> {
    return this.restaurants.find(task.restaurantId, context);
  }
}
