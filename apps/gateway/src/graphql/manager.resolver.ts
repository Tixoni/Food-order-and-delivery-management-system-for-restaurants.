import { Args, ID, Mutation, Query, Resolver } from "@nestjs/graphql";
import { ROLES, Roles } from "@food-delivery/service-kit";
import { CatalogClient } from "../catalog/catalog.client";
import { AccessToken } from "./gql.decorators";
import { MenuItem } from "./catalog.models";
import {
  DeliveryZone,
  RegisterRestaurantInput,
  RestaurantDetails,
  SaveDeliveryZoneInput,
  SaveMenuItemInput,
} from "./manager.models";

/**
 * Операции панели ресторана и панели администратора.
 *
 * Все они закрыты ролью, и ни одна не полагается на то, что клиентская
 * часть покажет нужные кнопки только нужным людям: права проверяются
 * здесь, а затем ещё раз в каталоге — владельцем данных (SEC-2).
 *
 * Сохранение устроено единой операцией «сохранить»: запись без
 * идентификатора создаётся, с идентификатором — изменяется. Для формы
 * редактора это одно и то же действие, и разделение на две операции
 * заставило бы клиентскую часть повторять эту развилку у себя.
 */
@Resolver()
export class ManagerResolver {
  constructor(private readonly catalog: CatalogClient) {}

  /** ADM-1: зоны доставки ресторана, включая отключённые. */
  @Roles(ROLES.manager, ROLES.admin)
  @Query(() => [DeliveryZone], { description: "Зоны доставки ресторана (ADM-1)" })
  async deliveryZones(
    @Args("restaurantId", { type: () => ID }) restaurantId: string,
    @AccessToken() token?: string,
  ): Promise<DeliveryZone[]> {
    const result = await this.catalog.zones(token, restaurantId);
    return result.zones;
  }

  /** ADM-1: сохранение контура зоны, нарисованного на карте. */
  @Roles(ROLES.manager, ROLES.admin)
  @Mutation(() => DeliveryZone, { description: "Создать или изменить зону доставки (ADM-1)" })
  async saveDeliveryZone(
    @Args("input") input: SaveDeliveryZoneInput,
    @AccessToken() token?: string,
  ): Promise<DeliveryZone> {
    return this.catalog.saveZone(token, input);
  }

  /** CAT-5: создание и изменение блюда. */
  @Roles(ROLES.manager, ROLES.admin)
  @Mutation(() => MenuItem, { description: "Создать или изменить блюдо (CAT-5)" })
  async saveMenuItem(
    @Args("input") input: SaveMenuItemInput,
    @AccessToken() token?: string,
  ): Promise<MenuItem> {
    return this.catalog.saveMenuItem(token, input);
  }

  /** ADM-2: регистрация ресторана администратором. */
  @Roles(ROLES.admin)
  @Mutation(() => RestaurantDetails, { description: "Зарегистрировать ресторан (ADM-2)" })
  async registerRestaurant(
    @Args("input") input: RegisterRestaurantInput,
    @AccessToken() token?: string,
  ): Promise<RestaurantDetails> {
    return this.catalog.registerRestaurant(token, input);
  }

  /** ADM-2: правка сведений о ресторане и его закрытие. */
  @Roles(ROLES.admin)
  @Mutation(() => RestaurantDetails, { description: "Изменить сведения о ресторане (ADM-2)" })
  async updateRestaurant(
    @Args("restaurantId", { type: () => ID }) restaurantId: string,
    @Args("input") input: RegisterRestaurantInput,
    @Args("isActive", { type: () => Boolean, nullable: true }) isActive?: boolean,
    @AccessToken() token?: string,
  ): Promise<RestaurantDetails> {
    return this.catalog.updateRestaurant(token, restaurantId, {
      ...input,
      ...(isActive !== undefined ? { isActive } : {}),
    });
  }
}
