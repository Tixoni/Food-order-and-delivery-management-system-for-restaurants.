import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { NotFoundError, ValidationError } from "@food-delivery/shared";
import { Courier } from "../../domain/courier";
import type { VehicleType } from "../../domain/geo";
import { domainCall } from "../errors";
import { DELIVERY_REPOSITORY, type DeliveryRepository } from "../ports/delivery.repository";
import { POSITION_CACHE, type PositionCache } from "../ports/positions";
import { Routing } from "../routing";
import { courierView } from "./courier.use-case";

export interface TrackingRequester {
  userId: string;
  roles: readonly string[];
}

const STAFF = ["operator", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VEHICLES: VehicleType[] = ["foot", "bike", "car"];

/**
 * Позиция курьера для клиента (TRK-2) и учёт курьеров администратором (ADM-2).
 *
 * SEC-7: позицию видит только клиент этого заказа и оператор. Чужому
 * клиенту — «не найдено», а не «нет прав»: не подтверждаем, что такой
 * заказ существует.
 */
@Injectable()
export class TrackingUseCase {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(POSITION_CACHE) private readonly positions: PositionCache,
    private readonly routing: Routing,
  ) {}

  async courierPosition(orderId: string, requester: TrackingRequester) {
    if (!UUID.test(orderId)) throw new NotFoundError("доставка не найдена");
    const delivery = await this.deliveries.deliveryOfOrder(orderId);
    const isStaff = requester.roles.some((role) => STAFF.includes(role));
    if (!delivery || (!isStaff && delivery.snapshot.customerId !== requester.userId)) {
      throw new NotFoundError("доставка не найдена", { orderId });
    }

    const state = delivery.snapshot;
    // Позиция показывается, пока курьер едет к ресторану или к клиенту.
    const visible =
      state.courierId && (state.status === "ASSIGNED" || state.status === "PICKED_UP");
    const [position, route] = await Promise.all([
      visible ? this.positions.get(state.courierId!) : null,
      this.routing.deliveryRoute(delivery),
    ]);
    return {
      orderId,
      deliveryId: state.id,
      status: state.status,
      courierId: visible ? state.courierId : null,
      // Нет свежей позиции — клиент увидит «позиция устарела», а не точку
      // часовой давности.
      position,
      dropoff: state.dropoff,
      pickup: state.pickup,
      // Путь по дорогам для карты клиента; без маршрутизатора — null,
      // и карта рисует прямую.
      route,
    };
  }

  async listCouriers() {
    return (await this.deliveries.listCouriers()).map(courierView);
  }

  /** ADM-2: курьер заводится администратором и привязывается к учётной записи. */
  async registerCourier(input: {
    fullName?: string;
    phone?: string | null;
    vehicleType?: string;
    userId?: string | null;
  }) {
    const fullName = input?.fullName?.trim();
    if (!fullName || fullName.length > 200) {
      throw new ValidationError("укажите имя курьера (до 200 символов)");
    }
    const vehicleType = (input.vehicleType ?? "foot") as VehicleType;
    if (!VEHICLES.includes(vehicleType)) {
      throw new ValidationError(`vehicleType: одно из ${VEHICLES.join(", ")}`);
    }
    if (input.userId && !UUID.test(input.userId)) {
      throw new ValidationError("userId: идентификатор учётной записи Keycloak");
    }

    const courier = Courier.restore({
      id: randomUUID(),
      userId: input.userId ?? null,
      fullName,
      phone: input.phone?.trim() || null,
      vehicleType,
      status: "offline",
      currentDeliveryId: null,
      isActive: true,
      lastLocation: null,
      lastLocationAt: null,
    });
    await domainCall(() => this.deliveries.transaction((tx) => tx.insertCourier(courier)));
    return courierView(courier);
  }
}
