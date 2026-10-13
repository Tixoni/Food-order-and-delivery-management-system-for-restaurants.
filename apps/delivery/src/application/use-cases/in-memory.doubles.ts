import { ExternalServiceError, type DomainEvent } from "@food-delivery/shared";
import { Courier, type CourierState } from "../../domain/courier";
import { Delivery, Offer, type DeliveryState, type OfferState } from "../../domain/delivery";
import { distanceMeters, type GeoPoint } from "../../domain/geo";
import {
  DuplicateDeliveryError,
  type Candidate,
  type CandidateInfo,
  type CourierDashboard,
  type DeliveryRepository,
  type DeliveryTx,
  type LocationContext,
} from "../ports/delivery.repository";
import type { LocationHistory, Position, PositionCache } from "../ports/positions";
import type { Route, RoutePlanner } from "../ports/route-planner";

/**
 * Хранилище в памяти с правилами базы: одна действующая доставка на заказ,
 * одно открытое предложение на доставку, откат транзакции при ошибке.
 */
export class InMemoryDeliveryRepository implements DeliveryRepository {
  couriers = new Map<string, CourierState>();
  deliveries = new Map<string, DeliveryState>();
  offers = new Map<string, OfferState>();
  readonly routes = new Map<string, Route>();
  readonly outbox: Array<{ event: DomainEvent; orderId: string }> = [];
  readonly shifts: Array<{ courierId: string; startedAt: Date; endedAt: Date | null }> = [];

  /** Время последней позиции для подбора: в базе его пишет пакетная запись. */
  freshUntil = new Map<string, Date>();

  async transaction<T>(work: (tx: DeliveryTx) => Promise<T>): Promise<T> {
    const backup = {
      couriers: structuredClone(this.couriers),
      deliveries: structuredClone(this.deliveries),
      offers: structuredClone(this.offers),
      outbox: this.outbox.length,
    };
    try {
      return await work(this.tx());
    } catch (error) {
      this.couriers = backup.couriers;
      this.deliveries = backup.deliveries;
      this.offers = backup.offers;
      this.outbox.length = backup.outbox;
      throw error;
    }
  }

  async dashboard(userId: string): Promise<CourierDashboard | null> {
    const state = [...this.couriers.values()].find((c) => c.userId === userId);
    if (!state) return null;
    const open = [...this.offers.values()].find((o) => o.courierId === state.id && !o.response);
    return {
      courier: Courier.restore(state),
      offer: open
        ? {
            offer: Offer.restore(open),
            delivery: Delivery.restore(this.deliveries.get(open.deliveryId)!),
          }
        : null,
      delivery: state.currentDeliveryId
        ? Delivery.restore(this.deliveries.get(state.currentDeliveryId)!)
        : null,
    };
  }

  async deliveryOfOrder(orderId: string) {
    const found = [...this.deliveries.values()].filter((d) => d.orderId === orderId).at(-1);
    return found ? Delivery.restore(found) : null;
  }

  async locationContext(userId: string): Promise<LocationContext | null> {
    const courier = [...this.couriers.values()].find((c) => c.userId === userId);
    if (!courier) return null;
    const delivery = courier.currentDeliveryId
      ? this.deliveries.get(courier.currentDeliveryId)
      : undefined;
    return { courierId: courier.id, status: courier.status, orderId: delivery?.orderId ?? null };
  }

  async listCouriers() {
    return [...this.couriers.values()].map((state) => Courier.restore(state));
  }

  async candidates(deliveryId: string, radiusMeters: number, freshSeconds: number, limit: number) {
    const state = this.deliveries.get(deliveryId);
    if (!state || state.status !== "PENDING") return null;
    const candidates: CandidateInfo[] = this.eligible(
      Delivery.restore(state),
      radiusMeters,
      freshSeconds,
    )
      .slice(0, limit)
      .map((c) => ({
        courierId: c.state.id,
        position: c.state.lastLocation!,
        vehicleType: c.state.vehicleType,
        distanceMeters: c.distance,
      }));
    return { pickup: state.pickup, candidates };
  }

  async routeOf(deliveryId: string) {
    return this.routes.get(deliveryId) ?? null;
  }

  async saveRoute(deliveryId: string, route: Route) {
    if (!this.routes.has(deliveryId)) this.routes.set(deliveryId, structuredClone(route));
  }

  /** Условия подбора, как в SQL: свободен, на связи, в радиусе, не предлагали в этом раунде. */
  private eligible(delivery: Delivery, radiusMeters: number, freshSeconds: number) {
    const offered = new Set(
      [...this.offers.values()]
        .filter(
          (o) => o.deliveryId === delivery.id && o.offeredAt >= delivery.snapshot.searchStartedAt,
        )
        .map((o) => o.courierId),
    );
    const now = Date.now();
    return [...this.couriers.values()]
      .filter(
        (c) =>
          c.status === "available" &&
          c.isActive &&
          c.userId &&
          c.lastLocation &&
          !offered.has(c.id) &&
          now - (this.freshUntil.get(c.id)?.getTime() ?? 0) <= freshSeconds * 1000,
      )
      .map((c) => ({
        state: c,
        distance: distanceMeters(c.lastLocation!, delivery.snapshot.pickup),
      }))
      .filter((c) => c.distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance);
  }

  addCourier(state: CourierState) {
    this.couriers.set(state.id, structuredClone(state));
    if (state.lastLocationAt) this.freshUntil.set(state.id, state.lastLocationAt);
  }

  eventsOfType(type: string) {
    return this.outbox.filter((entry) => entry.event.eventType === type).map((e) => e.event);
  }

  private tx(): DeliveryTx {
    const restoreDelivery = (state?: DeliveryState) => (state ? Delivery.restore(state) : null);
    return {
      deliveryById: async (id) => {
        return restoreDelivery(this.deliveries.get(id));
      },
      activeDeliveryByOrder: async (orderId) => {
        return restoreDelivery(
          [...this.deliveries.values()].find(
            (d) => d.orderId === orderId && d.status !== "CANCELLED" && d.status !== "DELIVERED",
          ),
        );
      },
      insertDelivery: async (delivery) => {
        const clash = [...this.deliveries.values()].some(
          (d) => d.orderId === delivery.snapshot.orderId && d.status !== "CANCELLED",
        );
        if (clash) throw new DuplicateDeliveryError(delivery.snapshot.orderId);
        this.deliveries.set(delivery.id, structuredClone(delivery.snapshot));
      },
      saveDelivery: async (delivery) => {
        this.deliveries.set(delivery.id, structuredClone(delivery.snapshot));
      },
      courierById: async (id) => {
        const state = this.couriers.get(id);
        return state ? Courier.restore(state) : null;
      },
      courierByUser: async (userId) => {
        const state = [...this.couriers.values()].find((c) => c.userId === userId);
        return state ? Courier.restore(state) : null;
      },
      insertCourier: async (courier) => {
        this.couriers.set(courier.id, structuredClone(courier.snapshot));
      },
      saveCourier: async (courier) => {
        this.couriers.set(courier.id, structuredClone(courier.snapshot));
      },
      openShift: async (courierId, at) => {
        this.shifts.push({ courierId, startedAt: at, endedAt: null });
      },
      closeShift: async (courierId, at) => {
        const open = this.shifts.find((s) => s.courierId === courierId && !s.endedAt);
        if (open) open.endedAt = at;
      },
      nearestCandidate: async (
        delivery,
        radiusMeters,
        freshSeconds,
        preferred,
      ): Promise<Candidate | null> => {
        const rank = (id: string) => {
          const index = preferred?.indexOf(id) ?? -1;
          return index === -1 ? Infinity : index;
        };
        const candidates = this.eligible(delivery, radiusMeters, freshSeconds)
          .slice(0, 10)
          .sort((a, b) => rank(a.state.id) - rank(b.state.id) || a.distance - b.distance);
        const best = candidates[0];
        return best
          ? { courier: Courier.restore(best.state), distanceMeters: best.distance }
          : null;
      },
      openOfferOf: async (deliveryId) => {
        const state = [...this.offers.values()].find(
          (o) => o.deliveryId === deliveryId && !o.response,
        );
        return state ? Offer.restore(state) : null;
      },
      offerById: async (id) => {
        const state = this.offers.get(id);
        return state ? Offer.restore(state) : null;
      },
      offersCount: async (deliveryId) => {
        return [...this.offers.values()].filter((o) => o.deliveryId === deliveryId).length;
      },
      insertOffer: async (offer) => {
        this.offers.set(offer.id, structuredClone(offer.snapshot));
      },
      saveOffer: async (offer) => {
        this.offers.set(offer.id, structuredClone(offer.snapshot));
      },
      dueOffers: async (now, limit) => {
        return [...this.offers.values()]
          .filter((o) => !o.response && o.expiresAt <= now)
          .slice(0, limit)
          .map((state) => Offer.restore(state));
      },
      enqueue: async (events, orderId) => {
        for (const event of events) this.outbox.push({ event, orderId });
      },
    };
  }
}

/**
 * Маршрутизатор для тестов: путь по дорогам задаётся функцией, по
 * умолчанию — прямая с поправкой 1,4. `down` — маршрутизатор недоступен.
 */
export class FakeRoutePlanner implements RoutePlanner {
  down = false;
  calls = 0;
  road: (from: GeoPoint, to: GeoPoint) => number | null = (from, to) =>
    distanceMeters(from, to) * 1.4;

  async roadDistances(from: GeoPoint[], to: GeoPoint) {
    this.calls += 1;
    if (this.down) throw new ExternalServiceError("маршрутизатор недоступен");
    return from.map((point) => this.road(point, to));
  }

  async route(from: GeoPoint, to: GeoPoint): Promise<Route | null> {
    this.calls += 1;
    if (this.down) throw new ExternalServiceError("маршрутизатор недоступен");
    const meters = this.road(from, to);
    return meters === null ? null : { distanceMeters: Math.round(meters), path: [from, to] };
  }
}

export class InMemoryPositions implements PositionCache, LocationHistory {
  readonly current = new Map<string, Position>();
  readonly published: Array<{ orderId: string; payload: unknown }> = [];
  readonly history: Array<{ courierId: string; position: Position }> = [];

  async save(courierId: string, position: Position) {
    this.current.set(courierId, position);
  }

  async get(courierId: string) {
    return this.current.get(courierId) ?? null;
  }

  async publish(orderId: string, payload: unknown) {
    this.published.push({ orderId, payload });
  }

  add(courierId: string, position: Position) {
    this.history.push({ courierId, position });
  }
}
