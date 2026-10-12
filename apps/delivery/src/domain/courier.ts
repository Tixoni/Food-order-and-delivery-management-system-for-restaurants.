import { DeliveryRuleError } from "./delivery-errors";
import type { GeoPoint, VehicleType } from "./geo";

/**
 * Курьер и его статус.
 *
 *   offline ──смена──▶ available ──предложение──▶ assigned ──принял──▶ busy
 *      ▲                 ▲  ▲                         │                  │
 *      └──конец смены────┘  └──отказ / молчание───────┘                  │
 *                           └──────────────доставил или заказ отменён────┘
 *
 * В подбор попадает только `available`: курьер, которому уже предложен
 * заказ, второго предложения не получит, пока не ответит на первое.
 */

export type CourierStatus = "offline" | "available" | "assigned" | "busy";

export interface CourierState {
  id: string;
  userId: string | null;
  fullName: string;
  phone: string | null;
  vehicleType: VehicleType;
  status: CourierStatus;
  currentDeliveryId: string | null;
  isActive: boolean;
  lastLocation: GeoPoint | null;
  lastLocationAt: Date | null;
}

export class Courier {
  private constructor(private state: CourierState) {}

  static restore(state: CourierState): Courier {
    return new Courier({ ...state });
  }

  get snapshot(): Readonly<CourierState> {
    return this.state;
  }

  get id() {
    return this.state.id;
  }

  get status() {
    return this.state.status;
  }

  get onShift() {
    return this.state.status !== "offline";
  }

  /** DLV-1. Повторное «на смену» ничего не меняет. */
  startShift(): boolean {
    if (!this.state.isActive) throw new DeliveryRuleError("курьер отключён администратором");
    if (!this.state.userId) {
      throw new DeliveryRuleError("курьер не привязан к учётной записи — смена невозможна");
    }
    if (this.state.status !== "offline") return false;
    this.state.status = "available";
    return true;
  }

  /** Уйти со смены можно только свободным: с заказом на руках — сначала доставка. */
  endShift(): boolean {
    if (this.state.status === "offline") return false;
    if (this.state.status !== "available") {
      throw new DeliveryRuleError("сначала ответьте на предложение или завершите доставку", {
        status: this.state.status,
      });
    }
    this.state.status = "offline";
    return true;
  }

  offer(): void {
    this.require("available", "предложить заказ можно только свободному курьеру");
    this.state.status = "assigned";
  }

  accept(deliveryId: string): void {
    this.require("assigned", "принять можно только предложенный заказ");
    this.state.status = "busy";
    this.state.currentDeliveryId = deliveryId;
  }

  /** Отказ, молчание или отмена заказа до ответа — снова свободен. */
  declineOffer(): void {
    if (this.state.status === "assigned") this.state.status = "available";
  }

  /** Заказ вручён или отменён — курьер свободен (если не ушёл со смены). */
  free(): void {
    if (this.state.status === "assigned" || this.state.status === "busy") {
      this.state.status = "available";
    }
    this.state.currentDeliveryId = null;
  }

  private require(status: CourierStatus, message: string): void {
    if (this.state.status !== status) {
      throw new DeliveryRuleError(message, { status: this.state.status });
    }
  }
}
