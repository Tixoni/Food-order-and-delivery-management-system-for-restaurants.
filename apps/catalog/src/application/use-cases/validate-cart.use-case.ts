import { Inject, Injectable } from "@nestjs/common";
import { DomainRuleError, NotFoundError, ValidationError } from "@food-delivery/shared";
import { Coordinates } from "../../domain/coordinates";
import type { OptionSelection } from "../../domain/menu-item";
import { isOpenAt } from "../../domain/restaurant-schedule";
import {
  DELIVERY_ZONE_REPOSITORY,
  type DeliveryZoneRepository,
} from "../ports/delivery-zone.repository";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";
import {
  RESTAURANT_SCHEDULE_REPOSITORY,
  type RestaurantScheduleRepository,
} from "../ports/restaurant-schedule.repository";

export interface ValidateCartInput {
  restaurantId: string;
  latitude: number;
  longitude: number;
  items: Array<{ itemId: string; quantity: number; selections?: OptionSelection[] }>;
}

/** Серверный снимок цены для Order. Ничего не резервирует и не создаёт заказ. */
@Injectable()
export class ValidateCartUseCase {
  constructor(
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(RESTAURANT_SCHEDULE_REPOSITORY)
    private readonly schedules: RestaurantScheduleRepository,
    @Inject(DELIVERY_ZONE_REPOSITORY) private readonly zones: DeliveryZoneRepository,
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
  ) {}

  async execute(input: ValidateCartInput, at = new Date()) {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      throw new ValidationError("корзина должна содержать от 1 до 100 позиций");
    }
    const restaurant = await this.restaurants.findById(input.restaurantId);
    if (!restaurant)
      throw new NotFoundError("ресторан не найден", { restaurantId: input.restaurantId });
    const intervals = await this.schedules.findByRestaurant(input.restaurantId);
    if (!restaurant.isActive || !isOpenAt(intervals, restaurant.timeZone, at)) {
      throw new DomainRuleError("ресторан сейчас не принимает заказы");
    }

    let point: Coordinates;
    try {
      point = Coordinates.create({ latitude: input.latitude, longitude: input.longitude });
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error));
    }
    const offer = await this.zones.findOfferForRestaurant(point, input.restaurantId);
    if (!offer) throw new DomainRuleError("ресторан не доставляет по указанному адресу");

    const categories = await this.menu.findCategories(input.restaurantId);
    const activeCategoryIds = new Set(
      categories.filter((category) => category.isActive).map((category) => category.id),
    );
    const lines = [];
    for (const requested of input.items) {
      if (
        !requested ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested.itemId)
      ) {
        throw new ValidationError("itemId должен быть UUID");
      }
      const item = await this.menu.findItemById(requested.itemId);
      if (
        !item ||
        item.restaurantId !== input.restaurantId ||
        !activeCategoryIds.has(item.categoryId)
      ) {
        throw new DomainRuleError("позиция не принадлежит действующему меню ресторана");
      }
      try {
        lines.push({
          itemId: item.id,
          name: item.name,
          ...item.calculatePrice(requested.selections ?? [], requested.quantity),
        });
      } catch (error) {
        throw new DomainRuleError(error instanceof Error ? error.message : String(error));
      }
    }
    const itemsAmount = lines.reduce((total, line) => total + line.lineTotal, 0);
    if (!Number.isSafeInteger(itemsAmount))
      throw new DomainRuleError("сумма корзины слишком велика");
    if (itemsAmount < offer.minOrderAmount) {
      throw new DomainRuleError("не достигнута минимальная сумма заказа", {
        required: offer.minOrderAmount,
        current: itemsAmount,
      });
    }
    return {
      restaurantId: input.restaurantId,
      zoneId: offer.zoneId,
      lines,
      itemsAmount,
      deliveryFee: offer.deliveryFee,
      total: itemsAmount + offer.deliveryFee,
      // Точка выдачи: заказ передаёт её доставке, которая к каталогу не ходит.
      pickup: restaurant.location
        ? { latitude: restaurant.location.latitude, longitude: restaurant.location.longitude }
        : null,
      validatedAt: at.toISOString(),
    };
  }
}
