import { Inject, Injectable } from "@nestjs/common";
import { createLogger } from "@food-delivery/shared";
import { InternalHttpClient } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/** Внешний контракт сервиса доставки — то, что шлюз от него получает. */

export interface GeoPointView {
  latitude: number;
  longitude: number;
}

export interface PositionView extends GeoPointView {
  at: string;
  accuracy?: number | null;
}

/** Маршрут «ресторан → клиент» по дорогам (DLV-6); нет — маршрутизатор недоступен. */
export interface DeliveryRouteView {
  distanceMeters: number;
  path: GeoPointView[];
}

export interface DeliveryTaskView {
  id: string;
  orderId: string;
  orderNumber: number | null;
  restaurantId: string | null;
  dropoffAddress: string | null;
  contactPhone: string | null;
  status: string;
  pickup: GeoPointView;
  dropoff: GeoPointView;
  readyAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  route?: DeliveryRouteView | null;
}

export interface CourierProfileView {
  id: string;
  fullName: string;
  phone: string | null;
  vehicleType: string;
  status: string;
  isActive: boolean;
}

export interface CourierDashboardView {
  courier: CourierProfileView;
  position: PositionView | null;
  offer: { id: string; sequence: number; expiresAt: string; delivery: DeliveryTaskView } | null;
  delivery: DeliveryTaskView | null;
}

export interface CourierPositionView {
  orderId: string;
  deliveryId: string;
  status: string;
  courierId: string | null;
  position: PositionView | null;
  pickup: GeoPointView;
  dropoff: GeoPointView;
  route?: DeliveryRouteView | null;
}

/**
 * Обращение шлюза к сервису доставки — с токеном пользователя: курьер
 * действует от своей учётной записи, а позицию курьера доставка
 * показывает только клиенту заказа (SEC-7). Шлюз прав не решает.
 *
 * Повторяются только чтения. Отметки курьера («принял», «забрал»)
 * не повторяются: второй запрос на уже выполненную отметку вернул бы
 * конфликт вместо результата первого.
 */
@Injectable()
export class DeliveryClient {
  private readonly http: InternalHttpClient;

  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) {
    this.http = new InternalHttpClient({
      name: "delivery",
      baseUrl: config.services.delivery,
      timeoutMs: config.services.timeoutMs,
      retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 300 },
      breaker: { failureThreshold: 5, openDurationMs: 10_000 },
      logger: createLogger({ service: "gateway", level: config.logLevel }).child({
        component: "delivery-client",
      }),
    });
  }

  dashboard(token: string | undefined) {
    return this.get<CourierDashboardView>("/couriers/me", token);
  }

  setShift(token: string | undefined, onShift: boolean) {
    return this.post<CourierProfileView>("/couriers/me/shift", token, { onShift });
  }

  /** Координата — каждые 5–10 с; потерянную заменит следующая, поэтому без повторов. */
  sendLocation(token: string | undefined, location: GeoPointView & { accuracy?: number | null }) {
    return this.post<{ accepted: boolean }>("/couriers/me/location", token, location);
  }

  accept(token: string | undefined, offerId: string) {
    return this.post<DeliveryTaskView>(`/offers/${encodeURIComponent(offerId)}/accept`, token, {});
  }

  reject(token: string | undefined, offerId: string) {
    return this.post<{ rejected: boolean }>(
      `/offers/${encodeURIComponent(offerId)}/reject`,
      token,
      {},
    );
  }

  pickedUp(token: string | undefined, deliveryId: string) {
    return this.post<DeliveryTaskView>(
      `/deliveries/${encodeURIComponent(deliveryId)}/picked-up`,
      token,
      {},
    );
  }

  delivered(token: string | undefined, deliveryId: string) {
    return this.post<DeliveryTaskView>(
      `/deliveries/${encodeURIComponent(deliveryId)}/delivered`,
      token,
      {},
    );
  }

  /** TRK-2: позиция курьера заказа — только клиенту этого заказа и оператору. */
  position(token: string | undefined, orderId: string) {
    return this.get<CourierPositionView>(
      `/orders/${encodeURIComponent(orderId)}/courier-position`,
      token,
    );
  }

  private get<T>(path: string, token: string | undefined) {
    return this.http.request<T>({ method: "GET", path, ...(token ? { token } : {}) });
  }

  private post<T>(path: string, token: string | undefined, body: unknown) {
    return this.http.request<T>({ method: "POST", path, body, ...(token ? { token } : {}) });
  }
}
