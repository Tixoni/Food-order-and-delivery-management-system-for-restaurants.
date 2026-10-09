import { Inject, Injectable } from "@nestjs/common";
import { DomainRuleError, NotFoundError } from "@food-delivery/shared";
import {
  isOpenAt,
  validateSchedule,
  type ScheduleInterval,
} from "../../domain/restaurant-schedule";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";
import {
  RESTAURANT_SCHEDULE_REPOSITORY,
  type RestaurantScheduleRepository,
} from "../ports/restaurant-schedule.repository";

@Injectable()
export class ManageRestaurantScheduleUseCase {
  constructor(
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(RESTAURANT_SCHEDULE_REPOSITORY)
    private readonly schedules: RestaurantScheduleRepository,
  ) {}

  async get(restaurantId: string): Promise<{ timeZone: string; intervals: ScheduleInterval[] }> {
    const restaurant = await this.restaurants.findById(restaurantId);
    if (!restaurant) throw new NotFoundError("ресторан не найден", { restaurantId });
    return {
      timeZone: restaurant.timeZone,
      intervals: await this.schedules.findByRestaurant(restaurantId),
    };
  }

  async replace(restaurantId: string, intervals: ScheduleInterval[]) {
    const result = await this.get(restaurantId);
    try {
      validateSchedule(intervals);
    } catch (error) {
      throw new DomainRuleError(error instanceof Error ? error.message : String(error));
    }
    await this.schedules.replace(restaurantId, intervals);
    return { ...result, intervals };
  }

  async orderability(restaurantId: string, at = new Date()) {
    const restaurant = await this.restaurants.findById(restaurantId);
    if (!restaurant) throw new NotFoundError("ресторан не найден", { restaurantId });
    const intervals = await this.schedules.findByRestaurant(restaurantId);
    return {
      restaurantId,
      isOpen: restaurant.isActive && isOpenAt(intervals, restaurant.timeZone, at),
      timeZone: restaurant.timeZone,
      checkedAt: at.toISOString(),
    };
  }
}
