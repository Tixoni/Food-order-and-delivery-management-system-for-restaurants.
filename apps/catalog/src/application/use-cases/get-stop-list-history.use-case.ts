import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError, ValidationError } from "@food-delivery/shared";
import type { StopListEntry } from "../../domain/stop-list";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";
import { STOP_LIST_REPOSITORY, type StopListRepository } from "../ports/stop-list.repository";

/**
 * История стоп-листа ресторана — для панели менеджера (шаг 1.7)
 * и для показателей ресторана (ADM-4).
 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

@Injectable()
export class GetStopListHistoryUseCase {
  constructor(
    @Inject(STOP_LIST_REPOSITORY) private readonly stopList: StopListRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
  ) {}

  async execute(query: { restaurantId: string; limit?: number }): Promise<StopListEntry[]> {
    if (!(await this.restaurants.findById(query.restaurantId))) {
      throw new NotFoundError("ресторан не найден", { restaurantId: query.restaurantId });
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      // Ограничение сверху — не придирка: запрос без предела на большой
      // истории выгребает таблицу целиком и занимает соединение к базе.
      throw new ValidationError(`limit должен быть целым числом от 1 до ${MAX_LIMIT}`, { limit });
    }

    return this.stopList.findHistory(query.restaurantId, limit);
  }
}
