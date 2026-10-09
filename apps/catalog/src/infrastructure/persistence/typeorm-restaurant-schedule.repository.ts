import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { RestaurantScheduleRepository } from "../../application/ports/restaurant-schedule.repository";
import type { ScheduleInterval } from "../../domain/restaurant-schedule";
import { RestaurantScheduleOrmEntity } from "./restaurant-schedule.orm-entity";

@Injectable()
export class TypeOrmRestaurantScheduleRepository implements RestaurantScheduleRepository {
  constructor(
    @InjectRepository(RestaurantScheduleOrmEntity)
    private readonly repository: Repository<RestaurantScheduleOrmEntity>,
  ) {}

  async findByRestaurant(restaurantId: string): Promise<ScheduleInterval[]> {
    const rows = await this.repository.find({
      where: { restaurantId },
      order: { dayOfWeek: "ASC" },
    });
    return rows.map((row) => ({
      dayOfWeek: row.dayOfWeek,
      opensAt: row.opensAt.slice(0, 5),
      closesAt: row.closesAt.slice(0, 5),
    }));
  }

  async replace(restaurantId: string, intervals: readonly ScheduleInterval[]): Promise<void> {
    await this.repository.manager.transaction(async (manager) => {
      await manager.delete(RestaurantScheduleOrmEntity, { restaurantId });
      if (intervals.length) {
        await manager.insert(
          RestaurantScheduleOrmEntity,
          intervals.map((interval) => ({ ...interval, restaurantId })),
        );
      }
    });
  }
}
