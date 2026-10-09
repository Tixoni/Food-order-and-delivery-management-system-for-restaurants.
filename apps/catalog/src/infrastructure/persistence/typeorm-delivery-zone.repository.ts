import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import type { Coordinates } from "../../domain/coordinates";
import type { DeliveryZone } from "../../domain/delivery-zone";
import type {
  DeliveryOffer,
  DeliveryZoneRepository,
} from "../../application/ports/delivery-zone.repository";
import { RestaurantMapper, type RestaurantColumns } from "./restaurant.mapper";
import { DeliveryZoneMapper, type DeliveryZoneRow } from "./delivery-zone.mapper";
import { writeOutbox } from "./outbox.writer";

/**
 * Зоны доставки поверх PostGIS.
 *
 * Запросы написаны на SQL, а не собраны построителем запросов: построитель
 * не знает географических функций, и попытка выразить их через него даёт
 * менее читаемый код с тем же самым SQL внутри.
 *
 * Главное здесь — форма условия отбора. Сравнение идёт по выражению
 * `area::geometry`, потому что ровно под это выражение построен индекс.
 * Написать `ST_Contains(area, точка)` без приведения типа — значит
 * потерять индекс и получить полный просмотр таблицы: на 50 000 зон
 * разница составила 27,2 мс против 2,4 мс (спайк 1, заметка 28).
 */
@Injectable()
export class TypeOrmDeliveryZoneRepository implements DeliveryZoneRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findOfferForRestaurant(
    point: Coordinates,
    restaurantId: string,
  ): Promise<DeliveryOffer | null> {
    const [longitude, latitude] = point.toLonLat();
    const rows = await this.dataSource.query<RestaurantOfferRow[]>(
      `SELECT r.id, r.name, r.min_order_amount, r.delivery_fee_base,
              r.avg_cooking_time_min, r.is_active, r.time_zone,
              z.id AS zone_id, z.name AS zone_name,
              z.delivery_fee, z.min_order_amount AS zone_min_order
         FROM delivery_zones z
         JOIN restaurants r ON r.id = z.restaurant_id
        WHERE r.id = $1 AND r.is_active AND z.is_active
          AND ST_Contains(z.area::geometry, ST_SetSRID(ST_MakePoint($2, $3), 4326))
        ORDER BY z.delivery_fee ASC, z.id ASC
        LIMIT 1`,
      [restaurantId, longitude, latitude],
    );
    const row = rows[0];
    return row
      ? {
          restaurant: RestaurantMapper.fromColumns(row),
          zoneId: row.zone_id,
          zoneName: row.zone_name,
          deliveryFee: row.delivery_fee,
          minOrderAmount: row.zone_min_order,
        }
      : null;
  }

  async findRestaurantsDeliveringTo(point: Coordinates, limit: number): Promise<DeliveryOffer[]> {
    const [longitude, latitude] = point.toLonLat();

    // DISTINCT ON оставляет по одной строке на ресторан: зоны намеренно
    // перекрываются, и один ресторан может накрывать адрес двумя зонами.
    // Берётся та, где доставка дешевле, — клиенту нужен лучший вариант,
    // а не первый попавшийся.
    const rows = await this.dataSource.query<RestaurantOfferRow[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON (r.id)
                r.id, r.name, r.min_order_amount,
                r.delivery_fee_base, r.avg_cooking_time_min, r.is_active, r.time_zone,
                z.id AS zone_id, z.name AS zone_name,
                z.delivery_fee, z.min_order_amount AS zone_min_order
           FROM delivery_zones z
           JOIN restaurants r ON r.id = z.restaurant_id
          WHERE z.is_active
            AND r.is_active
            AND ST_Contains(z.area::geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
          ORDER BY r.id, z.delivery_fee ASC
       ) offers
       ORDER BY offers.delivery_fee ASC, offers.name ASC
       LIMIT $3`,
      [longitude, latitude, limit],
    );

    return rows.map((row) => ({
      restaurant: RestaurantMapper.fromColumns(row),
      zoneId: row.zone_id,
      zoneName: row.zone_name,
      deliveryFee: row.delivery_fee,
      // Минимальная сумма заказа берётся из зоны: в дальней зоне она выше.
      minOrderAmount: row.zone_min_order,
    }));
  }

  async findByRestaurant(restaurantId: string): Promise<DeliveryZone[]> {
    const rows = await this.dataSource.query<DeliveryZoneRow[]>(
      `SELECT id, restaurant_id, name, delivery_fee, min_order_amount, is_active,
              ST_AsGeoJSON(area::geometry) AS area_geojson
         FROM delivery_zones
        WHERE restaurant_id = $1
        ORDER BY is_active DESC, name ASC`,
      [restaurantId],
    );

    return rows.map(DeliveryZoneMapper.toDomain);
  }

  async findById(zoneId: string): Promise<DeliveryZone | null> {
    const rows = await this.dataSource.query<DeliveryZoneRow[]>(
      `SELECT id, restaurant_id, name, delivery_fee, min_order_amount, is_active,
              ST_AsGeoJSON(area::geometry) AS area_geojson
         FROM delivery_zones
        WHERE id = $1`,
      [zoneId],
    );

    const row = rows[0];
    return row ? DeliveryZoneMapper.toDomain(row) : null;
  }

  async save(zone: DeliveryZone, events: readonly DomainEvent[] = []): Promise<void> {
    // ST_Multi приводит одиночный контур к множественному полигону —
    // тип колонки. ST_MakeValid исправляет самопересечение контура,
    // которое легко нарисовать мышью и невозможно заметить глазом:
    // без него база отвергнет такую зону целиком.
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO delivery_zones
         (id, restaurant_id, name, area, delivery_fee, min_order_amount, is_active)
       VALUES ($1, $2, $3,
               ST_Multi(ST_MakeValid(ST_GeomFromText($4, 4326)))::geography,
               $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              area = EXCLUDED.area,
              delivery_fee = EXCLUDED.delivery_fee,
              min_order_amount = EXCLUDED.min_order_amount,
              is_active = EXCLUDED.is_active`,
        [
          zone.id,
          zone.restaurantId,
          zone.name,
          DeliveryZoneMapper.ringToWkt(zone),
          zone.deliveryFee,
          zone.minOrderAmount,
          zone.isActive,
        ],
      );
      await writeOutbox(manager, events);
    });
  }
}

/** Строка выдачи «рестораны по адресу»: ресторан и условия подошедшей зоны. */
interface RestaurantOfferRow extends RestaurantColumns {
  zone_id: string;
  zone_name: string;
  delivery_fee: number;
  zone_min_order: number;
}
