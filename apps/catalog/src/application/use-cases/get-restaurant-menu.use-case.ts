import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError } from "@food-delivery/shared";
import { assembleMenu, type MenuSection } from "../../domain/menu-category";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

export interface GetRestaurantMenuQuery {
  restaurantId: string;
  /** Менеджеру нужны и блюда в стоп-листе; клиенту — только доступные. */
  includeUnavailable?: boolean;
}

/**
 * Требование CAT-2: показать меню ресторана, сгруппированное по категориям.
 *
 * Сценарий знает домен и порты, но не знает ни про HTTP, ни про SQL —
 * поэтому его тест не поднимает ни сервер, ни базу.
 */
@Injectable()
export class GetRestaurantMenuUseCase {
  constructor(
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
  ) {}

  async execute(query: GetRestaurantMenuQuery): Promise<MenuSection[]> {
    const restaurant = await this.restaurants.findById(query.restaurantId);
    if (!restaurant) {
      throw new NotFoundError("ресторан не найден", { restaurantId: query.restaurantId });
    }

    const [categories, items] = await Promise.all([
      this.menu.findCategories(query.restaurantId),
      this.menu.findItems(query.restaurantId, {
        includeUnavailable: query.includeUnavailable ?? false,
      }),
    ]);

    return assembleMenu(categories, items);
  }
}
