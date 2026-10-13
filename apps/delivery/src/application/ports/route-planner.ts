import type { GeoPoint } from "../../domain/geo";

/** Путь по дорогам: длина и линия для карты. */
export interface Route {
  distanceMeters: number;
  path: GeoPoint[];
}

/**
 * Маршрутизатор (DLV-6) — внешний движок OSRM.
 *
 * Сервис без него работает (REL-2): подбор идёт по прямому расстоянию,
 * прогноз — по прямой с поправкой на улицы, карта рисует прямую линию.
 * Поэтому любой отказ здесь — исключение, которое вызывающий гасит,
 * а не причина отказать курьеру или клиенту.
 */
export interface RoutePlanner {
  /**
   * Длина пути по дорогам от каждой точки `from` до `to`, метры — одним
   * матричным запросом. `null` — до этой точки дороги нет.
   */
  roadDistances(from: GeoPoint[], to: GeoPoint): Promise<(number | null)[]>;
  /** Маршрут между двумя точками; `null` — дороги нет. */
  route(from: GeoPoint, to: GeoPoint): Promise<Route | null>;
}

export const ROUTE_PLANNER = Symbol("RoutePlanner");
