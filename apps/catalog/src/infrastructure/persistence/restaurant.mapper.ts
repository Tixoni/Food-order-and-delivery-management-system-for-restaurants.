import { Restaurant } from "../../domain/restaurant";
import type { RestaurantOrmEntity } from "./restaurant.orm-entity";

/**
 * Преобразователь между представлением в базе и доменным объектом.
 *
 * Единственное место, где эти два мира встречаются. Благодаря ему
 * переименование колонки не приводит к правкам в доменном слое.
 */
export class RestaurantMapper {
  static toDomain(row: RestaurantOrmEntity): Restaurant {
    return Restaurant.create({
      id: row.id,
      name: row.name,
      minOrderAmount: row.minOrderAmount,
      deliveryFeeBase: row.deliveryFeeBase,
      avgCookingTimeMin: row.avgCookingTimeMin,
      isActive: row.isActive,
    });
  }

  static toPersistence(restaurant: Restaurant): Partial<RestaurantOrmEntity> {
    return {
      id: restaurant.id,
      name: restaurant.name,
      minOrderAmount: restaurant.minOrderAmount,
      deliveryFeeBase: restaurant.deliveryFeeBase,
      avgCookingTimeMin: restaurant.avgCookingTimeMin,
      isActive: restaurant.isActive,
    };
  }
}
