import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, NotFoundError, runWithContext } from "@food-delivery/shared";
import type { Courier } from "../../domain/courier";
import type { Delivery } from "../../domain/delivery";
import { etaMinutes, geoPoint, type GeoPoint } from "../../domain/geo";
import { deliveryEvents } from "../delivery-events";
import { domainCall, toAppError } from "../errors";
import {
  DELIVERY_REPOSITORY,
  type DeliveryRepository,
  type DeliveryTx,
} from "../ports/delivery.repository";
import {
  LOCATION_HISTORY,
  POSITION_CACHE,
  type LocationHistory,
  type PositionCache,
} from "../ports/positions";
import { DispatchUseCase } from "./dispatch.use-case";

/** Курьер в запросе: идентификатор учётной записи из проверенного токена. */
export interface CourierRequester {
  userId: string;
}

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
}

/**
 * Действия курьера (DLV-1, DLV-2, DLV-4, DLV-5).
 *
 * Курьер определяется по учётной записи из токена, а не по идентификатору
 * в запросе: курьер не может отметить чужую доставку или ответить
 * на чужое предложение, подставив другой номер (SEC-2).
 */
@Injectable()
export class CourierUseCase {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(POSITION_CACHE) private readonly positions: PositionCache,
    @Inject(LOCATION_HISTORY) private readonly history: LocationHistory,
    private readonly dispatch: DispatchUseCase,
  ) {}

  /** Экран курьера: статус, открытое предложение, текущая доставка. */
  async dashboard(requester: CourierRequester) {
    const view = await this.deliveries.dashboard(requester.userId);
    if (!view) throw notLinked();
    const position = await this.positions.get(view.courier.id);
    return {
      courier: courierView(view.courier),
      position,
      offer: view.offer
        ? {
            id: view.offer.offer.id,
            sequence: view.offer.offer.snapshot.sequence,
            expiresAt: view.offer.offer.snapshot.expiresAt,
            delivery: deliveryView(view.offer.delivery),
          }
        : null,
      delivery: view.delivery ? deliveryView(view.delivery) : null,
    };
  }

  /** DLV-1: на смену и со смены. */
  async setShift(requester: CourierRequester, onShift: boolean, now = new Date()) {
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const courier = await this.courierOf(tx, requester);
        const changed = onShift ? courier.startShift() : courier.endShift();
        if (changed) {
          await tx.saveCourier(courier);
          if (onShift) await tx.openShift(courier.id, now);
          else await tx.closeShift(courier.id, now);
        }
        return courierView(courier);
      }),
    );
  }

  /** DLV-4: принять предложение в срок. */
  async accept(requester: CourierRequester, offerId: string, now = new Date()) {
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const courier = await this.courierOf(tx, requester);
        const offer = await tx.offerById(offerId);
        if (!offer) throw new NotFoundError("предложение не найдено", { offerId });
        offer.respond(courier.id, "ACCEPTED", now);

        const delivery = await tx.deliveryById(offer.snapshot.deliveryId);
        if (!delivery) throw new NotFoundError("доставка не найдена");
        delivery.accept(courier.id, now);
        courier.accept(delivery.id);

        await tx.saveOffer(offer);
        await tx.saveDelivery(delivery);
        await tx.saveCourier(courier);
        await this.emit(tx, delivery, () =>
          deliveryEvents.courierAccepted(delivery, courier.id, now),
        );
        return deliveryView(delivery);
      }),
    );
  }

  /** DLV-4: отказаться — заказ сразу уходит следующему кандидату. */
  async reject(requester: CourierRequester, offerId: string, now = new Date()) {
    const deliveryId = await domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const courier = await this.courierOf(tx, requester);
        const offer = await tx.offerById(offerId);
        if (!offer) throw new NotFoundError("предложение не найдено", { offerId });
        offer.respond(courier.id, "REJECTED", now);
        courier.declineOffer();
        await tx.saveOffer(offer);
        await tx.saveCourier(courier);
        return offer.snapshot.deliveryId;
      }),
    );
    await this.dispatch.offerNext(deliveryId, now);
    return { rejected: true };
  }

  /** DLV-5: забрал заказ в ресторане. Прогноз — от ресторана до клиента. */
  async pickedUp(requester: CourierRequester, deliveryId: string, now = new Date()) {
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const courier = await this.courierOf(tx, requester);
        const delivery = await this.deliveryOf(tx, deliveryId);
        if (delivery.pickUp(courier.id, now)) {
          await tx.saveDelivery(delivery);
          const eta = etaMinutes(
            delivery.snapshot.pickup,
            delivery.snapshot.dropoff,
            courier.snapshot.vehicleType,
          );
          await this.emit(tx, delivery, () =>
            deliveryEvents.pickedUp(delivery, courier.id, now, eta),
          );
        }
        return deliveryView(delivery);
      }),
    );
  }

  /** DLV-5: вручил — курьер снова свободен. */
  async delivered(requester: CourierRequester, deliveryId: string, now = new Date()) {
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const courier = await this.courierOf(tx, requester);
        const delivery = await this.deliveryOf(tx, deliveryId);
        if (delivery.complete(courier.id, now)) {
          courier.free();
          await tx.saveDelivery(delivery);
          await tx.saveCourier(courier);
          await this.emit(tx, delivery, () => deliveryEvents.completed(delivery, courier.id, now));
        }
        return deliveryView(delivery);
      }),
    );
  }

  /**
   * DLV-2: координата курьера. В кэш и подписчикам заказа — сразу (PERF-3),
   * в историю — пачкой. Позиция принимается только на смене.
   */
  async updateLocation(requester: CourierRequester, input: LocationInput, now = new Date()) {
    let point: GeoPoint;
    try {
      point = geoPoint(Number(input?.latitude), Number(input?.longitude));
    } catch (error) {
      throw toAppError(error);
    }
    const context = await this.deliveries.locationContext(requester.userId);
    if (!context) throw notLinked();
    if (context.status === "offline") {
      throw new ForbiddenError("позиция принимается только на смене");
    }

    const position = {
      ...point,
      at: now,
      accuracy: finiteOrNull(input.accuracy),
      speed: finiteOrNull(input.speed),
    };
    await this.positions.save(context.courierId, position);
    this.history.add(context.courierId, position);
    if (context.orderId) {
      await this.positions.publish(context.orderId, {
        orderId: context.orderId,
        courierId: context.courierId,
        latitude: point.latitude,
        longitude: point.longitude,
        at: now.toISOString(),
      });
    }
    return { accepted: true };
  }

  private async courierOf(tx: DeliveryTx, requester: CourierRequester): Promise<Courier> {
    const courier = await tx.courierByUser(requester.userId);
    if (!courier) throw notLinked();
    return courier;
  }

  private async deliveryOf(tx: DeliveryTx, deliveryId: string): Promise<Delivery> {
    const delivery = await tx.deliveryById(deliveryId);
    if (!delivery) throw new NotFoundError("доставка не найдена", { deliveryId });
    return delivery;
  }

  /** Событие — со сквозным идентификатором запроса, начавшего подбор (OBS-2). */
  private emit(
    tx: DeliveryTx,
    delivery: Delivery,
    make: () => Parameters<DeliveryTx["enqueue"]>[0][number],
  ) {
    const correlationId = delivery.snapshot.correlationId;
    const event = correlationId ? runWithContext({ correlationId }, make) : make();
    return tx.enqueue([event], delivery.snapshot.orderId);
  }
}

function notLinked() {
  return new ForbiddenError("учётная запись не привязана к курьеру — обратитесь к администратору");
}

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return value === undefined || value === null || !Number.isFinite(number) ? null : number;
}

export function courierView(courier: Courier) {
  const state = courier.snapshot;
  return {
    id: state.id,
    fullName: state.fullName,
    phone: state.phone,
    vehicleType: state.vehicleType,
    status: state.status,
    isActive: state.isActive,
    userId: state.userId,
  };
}

export function deliveryView(delivery: Delivery) {
  const state = delivery.snapshot;
  return {
    id: state.id,
    orderId: state.orderId,
    status: state.status,
    courierId: state.courierId,
    pickup: state.pickup,
    dropoff: state.dropoff,
    readyAt: state.readyAt,
    acceptedAt: state.acceptedAt,
    pickedUpAt: state.pickedUpAt,
    deliveredAt: state.deliveredAt,
  };
}
