import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ConflictError,
  DomainRuleError,
  NotFoundError,
  createEvent,
  getCorrelationId,
} from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES, type DeliveryZoneChangedPayload } from "@food-delivery/contracts";
import { CoordinatesError } from "../../domain/coordinates";
import {
  DeliveryZone,
  DeliveryZoneError,
  ringFromPairs,
  type ZoneRing,
} from "../../domain/delivery-zone";
import {
  DELIVERY_ZONE_REPOSITORY,
  type DeliveryZoneRepository,
} from "../ports/delivery-zone.repository";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

/**
 * Редактор зоны доставки — требование ADM-1.
 *
 * Менеджер рисует контур на карте, поэтому почти все ошибки здесь —
 * ошибки пользователя: незамкнутый контур, две точки вместо трёх,
 * случайный клик в другом полушарии. Все они переводятся в понятные
 * ответы, а не в отказ сервиса.
 */

export interface CreateZoneInput {
  restaurantId: string;
  name?: string;
  ring: Array<{ latitude: number; longitude: number }>;
  deliveryFee?: number;
  minOrderAmount?: number;
}

export interface UpdateZoneInput {
  zoneId: string;
  restaurantId: string;
  name?: string;
  ring?: Array<{ latitude: number; longitude: number }>;
  deliveryFee?: number;
  minOrderAmount?: number;
  isActive?: boolean;
}

@Injectable()
export class ManageDeliveryZoneUseCase {
  constructor(
    @Inject(DELIVERY_ZONE_REPOSITORY) private readonly zones: DeliveryZoneRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
  ) {}

  async list(restaurantId: string): Promise<DeliveryZone[]> {
    await this.ensureRestaurantExists(restaurantId);
    return this.zones.findByRestaurant(restaurantId);
  }

  async create(input: CreateZoneInput): Promise<DeliveryZone> {
    const restaurant = await this.ensureRestaurantExists(input.restaurantId);

    const zone = this.build(() =>
      DeliveryZone.create({
        id: randomUUID(),
        restaurantId: input.restaurantId,
        name: input.name?.trim() || "Основная зона",
        ring: this.toRing(input.ring),
        // Условия ресторана — образец для новой зоны: менеджер чаще всего
        // рисует зону и ничего в условиях не меняет.
        deliveryFee: input.deliveryFee ?? restaurant.deliveryFeeBase,
        minOrderAmount: input.minOrderAmount ?? restaurant.minOrderAmount,
        isActive: true,
      }),
    );

    await this.zones.save(zone, [this.changed(zone, "created")]);
    return zone;
  }

  async update(input: UpdateZoneInput): Promise<DeliveryZone> {
    const existing = await this.zones.findById(input.zoneId);
    if (!existing) {
      throw new NotFoundError("зона доставки не найдена", { zoneId: input.zoneId });
    }

    // Менеджер одного ресторана не должен править зону другого.
    if (existing.restaurantId !== input.restaurantId) {
      throw new ConflictError("зона принадлежит другому ресторану", { zoneId: input.zoneId });
    }

    const current = existing.toProps();
    const zone = this.build(() =>
      DeliveryZone.create({
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.ring !== undefined ? { ring: this.toRing(input.ring) } : {}),
        ...(input.deliveryFee !== undefined ? { deliveryFee: input.deliveryFee } : {}),
        ...(input.minOrderAmount !== undefined ? { minOrderAmount: input.minOrderAmount } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      }),
    );

    await this.zones.save(zone, [this.changed(zone, "updated")]);
    return zone;
  }

  private changed(zone: DeliveryZone, change: DeliveryZoneChangedPayload["change"]) {
    const payload: DeliveryZoneChangedPayload = {
      restaurantId: zone.restaurantId,
      zoneId: zone.id,
      change,
    };
    return createEvent({
      eventType: CATALOG_EVENT_TYPES.deliveryZoneChanged,
      aggregateType: "DeliveryZone",
      aggregateId: zone.id,
      correlationId: getCorrelationId(),
      payload,
    });
  }

  /**
   * Отключение, а не удаление: зона может понадобиться снова — например,
   * когда ресторан вернёт доставку в дальний район. Кроме того, по удалённой
   * зоне нельзя разобрать спор о стоимости доставки в уже принятом заказе.
   */
  async deactivate(zoneId: string, restaurantId: string): Promise<DeliveryZone> {
    return this.update({ zoneId, restaurantId, isActive: false });
  }

  private async ensureRestaurantExists(restaurantId: string) {
    const restaurant = await this.restaurants.findById(restaurantId);
    if (!restaurant) {
      throw new NotFoundError("ресторан не найден", { restaurantId });
    }
    return restaurant;
  }

  private toRing(pairs: Array<{ latitude: number; longitude: number }>): ZoneRing {
    try {
      return ringFromPairs(pairs);
    } catch (error) {
      if (error instanceof CoordinatesError) {
        throw new DomainRuleError(error.message);
      }
      throw error;
    }
  }

  /** Нарушение правила предметной области — сообщение пользователю, а не сбой. */
  private build(build: () => DeliveryZone): DeliveryZone {
    try {
      return build();
    } catch (error) {
      if (error instanceof DeliveryZoneError || error instanceof Error) {
        throw new DomainRuleError(error.message);
      }
      throw error;
    }
  }
}
