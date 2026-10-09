import { Restaurant } from "../../domain/restaurant";
import type { RestaurantOrmEntity } from "./restaurant.orm-entity";

/**
 * Преобразователь между представлением в базе и доменным объектом.
 *
 * Единственное место, где эти два мира встречаются. Благодаря ему
 * переименование колонки не приводит к правкам в доменном слое.
 */
/**
 * Строка произвольной выборки, где от ресторана нужны только поля,
 * значимые для домена. Нужна там, где запрос написан на SQL и строки
 * приходят с именами колонок базы, а не с именами свойств класса.
 */
export interface RestaurantColumns {
  id: string;
  name: string;
  min_order_amount: number;
  delivery_fee_base: number;
  avg_cooking_time_min: number;
  is_active: boolean;
  time_zone?: string;
}

export class RestaurantMapper {
  static toDomain(row: RestaurantOrmEntity): Restaurant {
    return Restaurant.create({
      id: row.id,
      name: row.name,
      description: row.description,
      phone: row.phone,
      addressText: row.addressText,
      // В базе точка хранится в порядке «долгота, широта» — в домене
      // порядок задан именами полей, и перепутать их здесь нельзя.
      location: row.location
        ? { longitude: row.location.coordinates[0], latitude: row.location.coordinates[1] }
        : null,
      minOrderAmount: row.minOrderAmount,
      deliveryFeeBase: row.deliveryFeeBase,
      avgCookingTimeMin: row.avgCookingTimeMin,
      isActive: row.isActive,
      timeZone: row.timeZone,
    });
  }

  static fromColumns(row: RestaurantColumns): Restaurant {
    return Restaurant.create({
      id: row.id,
      name: row.name,
      minOrderAmount: row.min_order_amount,
      deliveryFeeBase: row.delivery_fee_base,
      avgCookingTimeMin: row.avg_cooking_time_min,
      isActive: row.is_active,
      timeZone: row.time_zone,
    });
  }

  static toPersistence(restaurant: Restaurant): Partial<RestaurantOrmEntity> {
    return {
      id: restaurant.id,
      name: restaurant.name,
      description: restaurant.description,
      phone: restaurant.phone,
      addressText: restaurant.addressText,
      location: restaurant.location
        ? {
            type: "Point",
            coordinates: [restaurant.location.longitude, restaurant.location.latitude],
          }
        : null,
      minOrderAmount: restaurant.minOrderAmount,
      deliveryFeeBase: restaurant.deliveryFeeBase,
      avgCookingTimeMin: restaurant.avgCookingTimeMin,
      isActive: restaurant.isActive,
      timeZone: restaurant.timeZone,
    };
  }
}
