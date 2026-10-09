import { Coordinates } from "../../domain/coordinates";
import { DeliveryZone } from "../../domain/delivery-zone";

/**
 * Перевод зоны доставки между базой и доменом.
 *
 * Контур хранится географическим типом, а читается как GeoJSON: это
 * единственный формат, одинаково понятный и базе, и браузерной карте,
 * и человеку, читающему выдачу запроса.
 */

/** Строка, как её отдаёт запрос зон: область уже переведена в GeoJSON. */
export interface DeliveryZoneRow {
  id: string;
  restaurant_id: string;
  name: string;
  area_geojson: string;
  delivery_fee: number;
  min_order_amount: number;
  is_active: boolean;
}

interface GeoJsonMultiPolygon {
  type: string;
  /** Множественный полигон: [полигон][контур][точка][долгота, широта]. */
  coordinates: number[][][][];
}

export class DeliveryZoneMapper {
  static toDomain(row: DeliveryZoneRow): DeliveryZone {
    return DeliveryZone.create({
      id: row.id,
      restaurantId: row.restaurant_id,
      name: row.name,
      ring: DeliveryZoneMapper.ringFromGeoJson(row.area_geojson),
      deliveryFee: row.delivery_fee,
      minOrderAmount: row.min_order_amount,
      isActive: row.is_active,
    });
  }

  /**
   * Внешний контур первого полигона.
   *
   * Домен работает с одним контуром — таким его рисует редактор карты
   * (ADM-1). Если в базе оказалась зона из нескольких кусков (её мог
   * создать наполнитель данных или прошлая версия редактора), берётся
   * первый: показать часть зоны лучше, чем не показать ничего.
   */
  private static ringFromGeoJson(raw: string): Coordinates[] {
    const parsed = JSON.parse(raw) as GeoJsonMultiPolygon;

    const polygon =
      parsed.type === "MultiPolygon"
        ? parsed.coordinates[0]
        : (parsed.coordinates as unknown as number[][][]);

    const ring = polygon?.[0] ?? [];

    // В GeoJSON порядок пары — «долгота, широта»; в домене порядок
    // задан именами полей, и перепутать их здесь нельзя.
    return ring.map(([longitude, latitude]) => Coordinates.create({ latitude, longitude }));
  }

  /**
   * Контур в виде, который понимают географические функции базы.
   *
   * Получившаяся строка передаётся в запрос параметром, а не склейкой
   * с текстом запроса: даже при том, что числа уже проверены доменом,
   * собирать SQL конкатенацией — привычка, которая однажды приводит
   * к внедрению кода в запрос.
   */
  static ringToWkt(zone: DeliveryZone): string {
    const points = zone
      .toLonLatRing()
      .map(([longitude, latitude]) => `${longitude} ${latitude}`)
      .join(", ");

    return `POLYGON((${points}))`;
  }
}
