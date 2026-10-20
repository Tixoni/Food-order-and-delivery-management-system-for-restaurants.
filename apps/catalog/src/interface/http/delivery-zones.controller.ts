import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { assertManagesRestaurant } from "./restaurant-access";
import { ManageDeliveryZoneUseCase } from "../../application/use-cases/manage-delivery-zone.use-case";
import type { DeliveryZone } from "../../domain/delivery-zone";

/**
 * Редактор зоны доставки — обратная сторона ADM-1.
 *
 * Контур передаётся списком пар «широта, долгота» — в том же порядке,
 * в каком его отдаёт картографическая библиотека браузера. Перевод
 * в порядок, принятый в базе, выполняется внутри, чтобы клиентскому коду
 * не пришлось помнить об этом различии.
 *
 * Права по токену проверяет assertManagesRestaurant; принадлежность зоны
 * ресторану дополнительно проверяется сценарием — это правило предметной
 * области и действует независимо от способа входа.
 */

interface ZonePoint {
  latitude: number;
  longitude: number;
}

interface CreateZoneBody {
  name?: string;
  ring: ZonePoint[];
  deliveryFee?: number;
  minOrderAmount?: number;
}

interface UpdateZoneBody extends Partial<CreateZoneBody> {
  restaurantId: string;
  isActive?: boolean;
}

const toResponse = (zone: DeliveryZone) => ({
  id: zone.id,
  restaurantId: zone.restaurantId,
  name: zone.name,
  ring: zone.ring.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
  deliveryFee: zone.deliveryFee,
  minOrderAmount: zone.minOrderAmount,
  isActive: zone.isActive,
});

@Controller()
export class DeliveryZonesController {
  constructor(private readonly zones: ManageDeliveryZoneUseCase) {}

  /** Все зоны ресторана, включая отключённые: менеджеру нужны все. */
  @Roles(ROLES.manager, ROLES.admin)
  @Get("restaurants/:restaurantId/zones")
  async list(@Param("restaurantId") restaurantId: string, @CurrentUser() user?: AuthenticatedUser) {
    assertManagesRestaurant(user, restaurantId);

    const zones = await this.zones.list(restaurantId);
    return { restaurantId, zones: zones.map(toResponse) };
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Post("restaurants/:restaurantId/zones")
  async create(
    @Param("restaurantId") restaurantId: string,
    @Body() body: CreateZoneBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);

    const zone = await this.zones.create({ ...body, restaurantId });
    return toResponse(zone);
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Patch("zones/:zoneId")
  async update(
    @Param("zoneId") zoneId: string,
    @Body() body: UpdateZoneBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, body.restaurantId);

    const zone = await this.zones.update({ ...body, zoneId });
    return toResponse(zone);
  }

  /**
   * Отключение зоны. Именно отключение, а не удаление: по удалённой зоне
   * нельзя разобрать спор о стоимости доставки в уже принятом заказе.
   */
  @Roles(ROLES.manager, ROLES.admin)
  @Delete("zones/:zoneId")
  async deactivate(
    @Param("zoneId") zoneId: string,
    @Query("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);

    const zone = await this.zones.deactivate(zoneId, restaurantId);
    return toResponse(zone);
  }
}
