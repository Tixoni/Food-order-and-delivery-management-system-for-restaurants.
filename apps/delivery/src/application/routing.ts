import { Inject, Injectable } from "@nestjs/common";
import type { Delivery } from "../domain/delivery";
import { travelSeconds } from "../domain/geo";
import type { DispatchSettings } from "./dispatch-settings";
import { DELIVERY_REPOSITORY, type DeliveryRepository } from "./ports/delivery.repository";
import { ROUTE_PLANNER, type Route, type RoutePlanner } from "./ports/route-planner";

/** Сколько ближайших по прямой кандидатов ранжируется по маршруту. */
const RANKED = 10;

/**
 * Маршруты для подбора и для экранов (DLV-3, DLV-6).
 *
 * Отказ маршрутизатора здесь гасится и никогда не доходит до курьера или
 * клиента (REL-2): подбор идёт по прямой, экран получает доставку без
 * линии маршрута, прогноз считается по прямой с поправкой на улицы.
 */
@Injectable()
export class Routing {
  constructor(
    @Inject(ROUTE_PLANNER) private readonly planner: RoutePlanner,
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
  ) {}

  /**
   * Порядок кандидатов по времени в пути до ресторана — по дорогам и с
   * учётом транспорта курьера. По прямой «ближний» может оказаться за
   * рекой или железной дорогой, а пеший в 500 м — дольше велосипедиста
   * в полутора километрах. Кандидаты по-прежнему отбираются индексом
   * (радиус 3 км, десять ближайших), маршрутизатор только меняет порядок.
   *
   * `null` — ранжировать нечего или маршрутизатор недоступен: тогда
   * предложение получает ближайший по прямой.
   */
  async rankCandidates(deliveryId: string, settings: DispatchSettings): Promise<string[] | null> {
    const found = await this.deliveries.candidates(
      deliveryId,
      settings.radiusMeters,
      settings.freshSeconds,
      RANKED,
    );
    if (!found || found.candidates.length < 2) return null;

    let roads: (number | null)[];
    try {
      roads = await this.planner.roadDistances(
        found.candidates.map((candidate) => candidate.position),
        found.pickup,
      );
    } catch {
      return null;
    }

    return found.candidates
      .map((candidate, index) => {
        const road = roads[index];
        return {
          id: candidate.courierId,
          // Без дороги до ресторана — в конец очереди, но не из подбора.
          seconds: road === null ? Infinity : travelSeconds(road, candidate.vehicleType),
          straight: candidate.distanceMeters,
        };
      })
      .sort((a, b) => a.seconds - b.seconds || a.straight - b.straight)
      .map((candidate) => candidate.id);
  }

  /**
   * Маршрут «ресторан → клиент»: сохранённый, а если его ещё нет —
   * посчитать и сохранить. Считается один раз на доставку: точки выдачи
   * и вручения не меняются. Если маршрутизатор был недоступен, следующий
   * просмотр экрана попробует снова.
   */
  async deliveryRoute(delivery: Delivery): Promise<Route | null> {
    const stored = await this.deliveries.routeOf(delivery.id);
    if (stored || delivery.status === "DELIVERED" || delivery.status === "CANCELLED") {
      return stored;
    }
    try {
      const route = await this.planner.route(delivery.snapshot.pickup, delivery.snapshot.dropoff);
      if (route) await this.deliveries.saveRoute(delivery.id, route);
      return route;
    } catch {
      return null;
    }
  }

  /** Только сохранённый маршрут — без обращения к маршрутизатору. */
  storedRoute(deliveryId: string): Promise<Route | null> {
    return this.deliveries.routeOf(deliveryId);
  }
}
