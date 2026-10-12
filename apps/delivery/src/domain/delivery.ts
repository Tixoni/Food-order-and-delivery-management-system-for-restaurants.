import { DeliveryConflictError, DeliveryRuleError } from "./delivery-errors";
import type { GeoPoint } from "./geo";

/**
 * Доставка заказа и предложения курьерам.
 *
 * Доставка:  PENDING ──принял──▶ ASSIGNED ──забрал──▶ PICKED_UP ──вручил──▶ DELIVERED
 *               └────────────── отмена заказа (до вручения) ──────────▶ CANCELLED
 *
 * Пока доставка в PENDING, идёт подбор: курьерам по очереди уходят
 * предложения (DLV-4). Каждое предложение — отдельная запись со своим
 * номером и сроком отклика, поэтому цепочка переназначений видна целиком.
 *
 * Статус заказа доставка не меняет: о каждом факте она сообщает событием,
 * а переход выполняет `order`.
 */

export type DeliveryStatus = "PENDING" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "CANCELLED";

export interface DeliveryState {
  id: string;
  orderId: string;
  restaurantId: string | null;
  customerId: string | null;
  orderNumber: number | null;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  dropoffAddress: string | null;
  contactPhone: string | null;
  status: DeliveryStatus;
  courierId: string | null;
  readyAt: Date | null;
  requestKey: string | null;
  correlationId: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  notFoundAt: Date | null;
  /**
   * Начало текущего раунда поиска. Отказавшиеся и промолчавшие в этом
   * раунде курьеры заказ повторно не получают; новый запрос от order
   * начинает новый раунд — предлагать снова можно всем.
   */
  searchStartedAt: Date;
  version: number;
}

export class Delivery {
  private constructor(private state: DeliveryState) {}

  static restore(state: DeliveryState): Delivery {
    return new Delivery({ ...state });
  }

  static open(input: {
    id: string;
    orderId: string;
    restaurantId: string | null;
    customerId: string | null;
    orderNumber?: number | null;
    pickup: GeoPoint;
    dropoff: GeoPoint;
    dropoffAddress?: string | null;
    contactPhone?: string | null;
    readyAt: Date | null;
    requestKey: string;
    correlationId: string | null;
    now: Date;
  }): Delivery {
    return new Delivery({
      id: input.id,
      orderId: input.orderId,
      restaurantId: input.restaurantId,
      customerId: input.customerId,
      orderNumber: input.orderNumber ?? null,
      pickup: input.pickup,
      dropoff: input.dropoff,
      dropoffAddress: input.dropoffAddress ?? null,
      contactPhone: input.contactPhone ?? null,
      status: "PENDING",
      courierId: null,
      readyAt: input.readyAt,
      requestKey: input.requestKey,
      correlationId: input.correlationId,
      createdAt: input.now,
      acceptedAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      cancelledAt: null,
      notFoundAt: null,
      searchStartedAt: input.now,
      version: 1,
    });
  }

  get snapshot(): Readonly<DeliveryState> {
    return this.state;
  }

  get id() {
    return this.state.id;
  }

  get status() {
    return this.state.status;
  }

  get isActive() {
    return this.state.status !== "DELIVERED" && this.state.status !== "CANCELLED";
  }

  /** Повторный запрос курьера с новым ключом — после «не найден», новый раунд поиска. */
  requestedAgain(requestKey: string, at: Date): void {
    this.state.requestKey = requestKey;
    this.state.notFoundAt = null;
    this.state.searchStartedAt = at;
  }

  notFound(at: Date): void {
    this.state.notFoundAt = at;
  }

  accept(courierId: string, at: Date): void {
    if (this.state.status !== "PENDING") {
      throw new DeliveryConflictError("заказ уже принят другим курьером или отменён", {
        status: this.state.status,
      });
    }
    this.state.status = "ASSIGNED";
    this.state.courierId = courierId;
    this.state.acceptedAt = at;
  }

  /** DLV-5. Повтор отметки тем же курьером ничего не меняет. */
  pickUp(courierId: string, at: Date): boolean {
    this.requireCourier(courierId);
    if (this.state.status === "PICKED_UP") return false;
    if (this.state.status !== "ASSIGNED") {
      throw new DeliveryRuleError("забрать можно только принятый заказ", {
        status: this.state.status,
      });
    }
    this.state.status = "PICKED_UP";
    this.state.pickedUpAt = at;
    return true;
  }

  /** «Доставил» — только после «забрал»: иначе заказ вручается, не покинув ресторан. */
  complete(courierId: string, at: Date): boolean {
    this.requireCourier(courierId);
    if (this.state.status === "DELIVERED") return false;
    if (this.state.status !== "PICKED_UP") {
      throw new DeliveryRuleError("сначала отметьте, что забрали заказ", {
        status: this.state.status,
      });
    }
    this.state.status = "DELIVERED";
    this.state.deliveredAt = at;
    return true;
  }

  /** Отмена заказа. Вручённый заказ не отменяется — его уже не вернуть. */
  cancel(at: Date): boolean {
    if (!this.isActive) return false;
    this.state.status = "CANCELLED";
    this.state.cancelledAt = at;
    return true;
  }

  private requireCourier(courierId: string): void {
    if (this.state.courierId !== courierId) {
      throw new DeliveryConflictError("доставка назначена другому курьеру");
    }
  }
}

export type OfferResponse = "ACCEPTED" | "REJECTED" | "TIMEOUT" | "CANCELLED";

export interface OfferState {
  id: string;
  deliveryId: string;
  courierId: string;
  sequence: number;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  response: OfferResponse | null;
}

/** Предложение заказа курьеру с номером попытки и сроком отклика (DLV-4). */
export class Offer {
  private constructor(private state: OfferState) {}

  static restore(state: OfferState): Offer {
    return new Offer({ ...state });
  }

  static make(input: {
    id: string;
    deliveryId: string;
    courierId: string;
    sequence: number;
    now: Date;
    ttlSeconds: number;
  }): Offer {
    return new Offer({
      id: input.id,
      deliveryId: input.deliveryId,
      courierId: input.courierId,
      sequence: input.sequence,
      offeredAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000),
      respondedAt: null,
      response: null,
    });
  }

  get snapshot(): Readonly<OfferState> {
    return this.state;
  }

  get id() {
    return this.state.id;
  }

  get isOpen() {
    return this.state.response === null;
  }

  /**
   * Ответ курьера. Принять просроченное нельзя: к этому времени заказ
   * уже мог уйти следующему курьеру — гонка из [[13]].
   */
  respond(courierId: string, response: "ACCEPTED" | "REJECTED", at: Date): void {
    if (this.state.courierId !== courierId) {
      throw new DeliveryConflictError("предложение адресовано другому курьеру");
    }
    if (!this.isOpen) {
      throw new DeliveryConflictError("предложение уже закрыто", {
        response: this.state.response,
      });
    }
    if (response === "ACCEPTED" && at >= this.state.expiresAt) {
      throw new DeliveryConflictError("предложение просрочено: заказ предложен другому курьеру");
    }
    this.close(response, at);
  }

  expire(at: Date): void {
    if (this.isOpen) this.close("TIMEOUT", at);
  }

  cancel(at: Date): void {
    if (this.isOpen) this.close("CANCELLED", at);
  }

  private close(response: OfferResponse, at: Date): void {
    this.state.response = response;
    this.state.respondedAt = at;
  }
}
