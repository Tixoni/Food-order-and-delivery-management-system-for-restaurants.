import { Controller, Get, Query } from "@nestjs/common";
import { ListRestaurantsUseCase } from "../../application/use-cases/list-restaurants.use-case";
import type { Restaurant } from "../../domain/restaurant";

/**
 * Слой интерфейса: принимает запрос, вызывает сценарий, превращает
 * доменные объекты в ответ. Бизнес-правил здесь нет — только преобразование.
 *
 * Доменный объект наружу не отдаётся: иначе внутреннее устройство домена
 * станет частью внешнего контракта, и его нельзя будет менять.
 */
interface RestaurantResponse {
  id: string;
  name: string;
  minOrderAmount: number;
  deliveryFee: number;
  avgCookingTimeMin: number;
}

const toResponse = (restaurant: Restaurant): RestaurantResponse => ({
  id: restaurant.id,
  name: restaurant.name,
  minOrderAmount: restaurant.minOrderAmount,
  deliveryFee: restaurant.deliveryFeeBase,
  avgCookingTimeMin: restaurant.avgCookingTimeMin,
});

@Controller("restaurants")
export class RestaurantsController {
  constructor(private readonly listRestaurants: ListRestaurantsUseCase) {}

  @Get()
  async list(@Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    const result = await this.listRestaurants.execute({
      ...(page !== undefined ? { page: Number(page) } : {}),
      ...(pageSize !== undefined ? { pageSize: Number(pageSize) } : {}),
    });

    return {
      items: result.items.map(toResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
