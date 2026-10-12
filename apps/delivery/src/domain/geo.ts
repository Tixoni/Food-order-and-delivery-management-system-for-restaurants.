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

/** Средняя скорость в городе, км/ч — грубая оценка до подключения маршрутизатора (DLV-6). */
const SPEED_KMH: Record<VehicleType, number> = { foot: 5, bike: 14, car: 20 };

/** Улицы не прямые: путь по ним в среднем на 40 % длиннее прямой. */
const DETOUR = 1.4;

/**
 * Прогноз времени в пути, минуты. Пока без OSRM: прямая, поправка на
 * извилистость улиц и средняя скорость транспорта. Прогноз по маршруту —
 * шаг 3.D7, за размыкателем цепи.
 */
export function etaMinutes(from: GeoPoint, to: GeoPoint, vehicle: VehicleType): number {
  const km = (distanceMeters(from, to) * DETOUR) / 1000;
  return Math.max(1, Math.ceil((km / SPEED_KMH[vehicle]) * 60));
}
