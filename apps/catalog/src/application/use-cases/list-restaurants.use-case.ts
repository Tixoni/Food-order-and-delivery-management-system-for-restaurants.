import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError, ValidationError } from "@food-delivery/shared";
import type { Restaurant } from "../../domain/restaurant";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

export interface ListRestaurantsQuery {
  page?: number;
  pageSize?: number;
}

export interface ListRestaurantsResult {
  items: Restaurant[];
  total: number;
  page: number;
  pageSize: number;
}

const MAX_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Сценарий использования: слой application.
 *
 * Знает домен и порт хранилища. Не знает ни про HTTP, ни про SQL —
 * поэтому его тест не поднимает ни сервер, ни базу.
 */
@Injectable()
export class ListRestaurantsUseCase {
  constructor(
    @Inject(RESTAURANT_REPOSITORY)
    private readonly restaurants: RestaurantRepository,
  ) {}

  async execute(query: ListRestaurantsQuery = {}): Promise<ListRestaurantsResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError("номер страницы должен быть целым числом от 1", { page });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new ValidationError(`размер страницы должен быть от 1 до ${MAX_PAGE_SIZE}`, {
        pageSize,
      });
    }

    const [items, total] = await Promise.all([
      this.restaurants.findActive(pageSize, (page - 1) * pageSize),
      this.restaurants.countActive(),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Один ресторан — по прямой ссылке на меню и для заказа в истории клиента.
   * Закрытый ресторан тоже отдаётся: его название нужно в старых заказах.
   */
  async getOne(restaurantId: string): Promise<Restaurant> {
    // Неверный идентификатор — тоже «не найден», а не ошибка базы о формате UUID.
    const restaurant = UUID.test(restaurantId)
      ? await this.restaurants.findById(restaurantId)
      : null;
    if (!restaurant) throw new NotFoundError("ресторан не найден", { restaurantId });
    return restaurant;
  }
}
