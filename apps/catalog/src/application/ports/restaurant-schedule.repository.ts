import type { ScheduleInterval } from "../../domain/restaurant-schedule";

export interface RestaurantScheduleRepository {
  findByRestaurant(restaurantId: string): Promise<ScheduleInterval[]>;
  replace(restaurantId: string, intervals: readonly ScheduleInterval[]): Promise<void>;
}

export const RESTAURANT_SCHEDULE_REPOSITORY = Symbol("RestaurantScheduleRepository");
