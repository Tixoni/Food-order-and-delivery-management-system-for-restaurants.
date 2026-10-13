import { DeliveryRuleError } from "./delivery-errors";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function geoPoint(latitude: number, longitude: number): GeoPoint {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new DeliveryRuleError("координаты вне допустимого диапазона", { latitude, longitude });
  }
  return { latitude, longitude };
}

const EARTH_RADIUS_M = 6_371_000;

/** Расстояние по прямой, метры. Для прогноза — маршрут длиннее, см. `etaMinutes`. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export type VehicleType = "foot" | "bike" | "car";

/**
 * Средняя скорость в городе с остановками и пробками, км/ч. Время в пути
 * считается как длина пути по дорогам, делённая на эту скорость: время
 * самого OSRM — для машины по пустым улицам, курьеру на велосипеде или
 * пешком оно не подходит, а машине в часы пик даёт заниженный прогноз.
 */
const SPEED_KMH: Record<VehicleType, number> = { foot: 5, bike: 14, car: 20 };

/**
 * Улицы не прямые: путь по ним в среднем на 40 % длиннее прямой
 * (медиана 1,41 на 200 маршрутах по Москве — спайк OSRM). Нужна, только
 * когда маршрутизатор недоступен.
 */
const DETOUR = 1.4;

/** Время в пути по дорогам, секунды. */
export function travelSeconds(roadMeters: number, vehicle: VehicleType): number {
  return (roadMeters / 1000 / SPEED_KMH[vehicle]) * 3600;
}

/**
 * Прогноз времени в пути, минуты (DLV-6): по длине маршрута, а без
 * маршрутизатора — по прямой с поправкой на извилистость улиц.
 */
export function etaMinutes(
  from: GeoPoint,
  to: GeoPoint,
  vehicle: VehicleType,
  roadMeters: number | null = null,
): number {
  const meters = roadMeters ?? distanceMeters(from, to) * DETOUR;
  return Math.max(1, Math.ceil(travelSeconds(meters, vehicle) / 60));
}
