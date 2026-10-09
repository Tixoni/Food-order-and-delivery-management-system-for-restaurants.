import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DomainRuleError,
  NotFoundError,
  createEvent,
  getCorrelationId,
} from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES, type RestaurantChangedPayload } from "@food-delivery/contracts";
import { Restaurant, RestaurantValidationError } from "../../domain/restaurant";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

/**
 * Регистрация ресторанов — требование ADM-2.
 *
 * Ресторан заводит администратор площадки, а не сам ресторан: иначе
 * в каталоге появятся заведения, с которыми нет договора. Проверку роли
 * выполняет слой интерфейса, здесь — правила предметной области.
 */

export interface RegisterRestaurantInput {
  name: string;
  description?: string | null;
  phone?: string | null;
  addressText?: string | null;
  location?: { latitude: number; longitude: number } | null;
  minOrderAmount?: number;
  deliveryFeeBase?: number;
  avgCookingTimeMin?: number;
  timeZone?: string;
}

export interface UpdateRestaurantInput extends Partial<RegisterRestaurantInput> {
  restaurantId: string;
  isActive?: boolean;
}

/** Значения по умолчанию: 500 рублей минимальный заказ, 149 рублей доставка. */
const DEFAULT_MIN_ORDER = 50000;
const DEFAULT_DELIVERY_FEE = 14900;
const DEFAULT_COOKING_TIME = 30;

@Injectable()
export class ManageRestaurantUseCase {
  constructor(@Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository) {}

  async register(input: RegisterRestaurantInput): Promise<Restaurant> {
    const restaurant = this.build(() =>
      Restaurant.create({
        id: randomUUID(),
        name: input.name,
        description: input.description ?? null,
        phone: input.phone ?? null,
        addressText: input.addressText ?? null,
        location: input.location ?? null,
        minOrderAmount: input.minOrderAmount ?? DEFAULT_MIN_ORDER,
        deliveryFeeBase: input.deliveryFeeBase ?? DEFAULT_DELIVERY_FEE,
        avgCookingTimeMin: input.avgCookingTimeMin ?? DEFAULT_COOKING_TIME,
        timeZone: input.timeZone,
        // Новый ресторан сразу виден клиентам: администратор заводит его
        // тогда, когда договор уже подписан.
        isActive: true,
      }),
    );

    await this.restaurants.save(restaurant, [this.changed(restaurant.id, "created")]);
    return restaurant;
  }

  async update(input: UpdateRestaurantInput): Promise<Restaurant> {
    const existing = await this.restaurants.findById(input.restaurantId);
    if (!existing) {
      throw new NotFoundError("ресторан не найден", { restaurantId: input.restaurantId });
    }

    const current = existing.toProps();
    const updated = this.build(() =>
      Restaurant.create({
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.minOrderAmount !== undefined ? { minOrderAmount: input.minOrderAmount } : {}),
        ...(input.deliveryFeeBase !== undefined ? { deliveryFeeBase: input.deliveryFeeBase } : {}),
        ...(input.avgCookingTimeMin !== undefined
          ? { avgCookingTimeMin: input.avgCookingTimeMin }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      }),
    );

    await this.restaurants.save(updated, [this.changed(updated.id, "updated")]);
    return updated;
  }

  private changed(restaurantId: string, change: RestaurantChangedPayload["change"]) {
    const payload: RestaurantChangedPayload = { restaurantId, change };
    return createEvent({
      eventType: CATALOG_EVENT_TYPES.restaurantChanged,
      aggregateType: "Restaurant",
      aggregateId: restaurantId,
      correlationId: getCorrelationId(),
      payload,
    });
  }

  /** Нарушение правила предметной области — сообщение пользователю, а не сбой. */
  private build(build: () => Restaurant): Restaurant {
    try {
      return build();
    } catch (error) {
      if (error instanceof RestaurantValidationError || error instanceof Error) {
        throw new DomainRuleError(error.message);
      }
      throw error;
    }
  }
}
