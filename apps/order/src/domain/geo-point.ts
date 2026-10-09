import { OrderRuleError } from "./order-errors";

/** Точка на карте: адрес доставки или точка выдачи заказа. */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export function geoPoint(latitude: number, longitude: number): GeoPoint {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new OrderRuleError("широта должна быть числом от −90 до 90", { latitude });
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new OrderRuleError("долгота должна быть числом от −180 до 180", { longitude });
  }
  return { latitude, longitude };
}
