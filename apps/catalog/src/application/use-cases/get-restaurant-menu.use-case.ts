import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError } from "@food-delivery/shared";
import { assembleMenu, type MenuSection } from "../../domain/menu-category";
import { MENU_CACHE, type MenuCache } from "../ports/menu-cache";
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
 * Сценарий знает домен и порты, но не знает ни про HTTP, ни про SQL,
 * ни про то, что кэш — это Redis, — поэтому его тест не поднимает
 * ни сервер, ни базу, ни кэш.
 *
 * Чтение идёт через кэш: меню открывают на каждом заходе клиента,
 * а меняют несколько раз в день. При изменении кэш сбрасывается;
 * короткий TTL ограничивает устаревание, если сброс не сработал.
 */
@Injectable()
export class GetRestaurantMenuUseCase {
  constructor(
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(MENU_CACHE) private readonly cache: MenuCache,
  ) {}

  async execute(query: GetRestaurantMenuQuery): Promise<MenuSection[]> {
    const includeUnavailable = query.includeUnavailable ?? false;

    // Проверка существования ресторана идёт до кэша: «ресторан не найден» —
    // это ответ, который клиент должен получить и при заполненном кэше.
    const restaurant = await this.restaurants.findById(query.restaurantId);
    if (!restaurant) {
      throw new NotFoundError("ресторан не найден", { restaurantId: query.restaurantId });
    }

    const cached = await this.cache.read(query.restaurantId, includeUnavailable);
    if (cached) {
      return cached;
    }

    const [categories, items] = await Promise.all([
      this.menu.findCategories(query.restaurantId),
      this.menu.findItems(query.restaurantId, { includeUnavailable }),
    ]);

    const sections = assembleMenu(categories, items);
    await this.cache.write(query.restaurantId, includeUnavailable, sections);

    return sections;
  }
}
