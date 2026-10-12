import { Inject, Injectable } from "@nestjs/common";
import { createLogger } from "@food-delivery/shared";
import { InternalHttpClient } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import type { OrderTransitionView, OrderView, PlaceOrderRequest } from "./order.views";

/**
 * Обращение шлюза к сервису заказов.
 *
 * Как и с каталогом, токен пользователя передаётся дальше без изменений:
 * чей это заказ и можно ли его отменить, решает `order` — владелец данных
 * (SEC-2). Шлюз заказы не кэширует: статус меняется каждые несколько
 * минут, и устаревший статус на экране отслеживания хуже лишнего запроса.
 *
 * Повторяются только чтение и оформление: у оформления есть ключ
 * идемпотентности, и повтор вернёт тот же заказ (ORD-4). Отмена
 * не повторяется — второй запрос на отменённый заказ вернул бы конфликт
 * вместо результата первого.
 */
@Injectable()
export class OrderClient {
  private readonly http: InternalHttpClient;

  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) {
    this.http = new InternalHttpClient({
      name: "order",
      baseUrl: config.services.order,
      timeoutMs: config.services.timeoutMs,
      retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 300 },
      breaker: { failureThreshold: 5, openDurationMs: 10_000 },
      logger: createLogger({ service: "gateway", level: config.logLevel }).child({
        component: "order-client",
      }),
    });
  }

  /** ORD-1, ORD-4: оформление; повтор с тем же ключом — тот же заказ. */
  place(
    token: string | undefined,
    request: PlaceOrderRequest,
  ): Promise<{ replayed: boolean; order: OrderView }> {
    return this.http.request({
      method: "POST",
      path: "/orders",
      body: request,
      idempotent: true,
      ...(token ? { token } : {}),
    });
  }

  /** ORD-7: история заказов клиента. */
  async mine(token: string | undefined, limit: number, offset: number): Promise<OrderView[]> {
    const result = await this.http.request<{ items: OrderView[] }>({
      method: "GET",
      path: `/orders?limit=${limit}&offset=${offset}`,
      ...(token ? { token } : {}),
    });
    return result.items;
  }

  /** TRK-1: заказ целиком. */
  get(token: string | undefined, orderId: string): Promise<OrderView> {
    return this.http.request({
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}`,
      ...(token ? { token } : {}),
    });
  }

  /** История переходов статусов — для шкалы на экране отслеживания. */
  async transitions(token: string | undefined, orderId: string): Promise<OrderTransitionView[]> {
    const history = await this.http.request<{ transitions: OrderTransitionView[] }>({
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}/history`,
      ...(token ? { token } : {}),
    });
    return history.transitions;
  }

  /** KIT-1: очередь кухни ресторана. Права — у сервиса заказов (кухня своего ресторана). */
  async kitchenQueue(token: string | undefined, restaurantId: string): Promise<OrderView[]> {
    const result = await this.http.request<{ items: OrderView[] }>({
      method: "GET",
      path: `/restaurants/${encodeURIComponent(restaurantId)}/kitchen-queue`,
      ...(token ? { token } : {}),
    });
    return result.items;
  }

  /** KIT-2, KIT-3, KIT-4: команды кухни. Не повторяются: повтор вернул бы конфликт. */
  kitchenCommand(
    token: string | undefined,
    orderId: string,
    command: "confirm" | "reject" | "ready",
    body: Record<string, unknown> = {},
  ): Promise<OrderView> {
    return this.http.request({
      method: "POST",
      path: `/orders/${encodeURIComponent(orderId)}/${command}`,
      body,
      ...(token ? { token } : {}),
    });
  }

  /** ORD-5: отмена клиентом до начала готовки. */
  cancel(token: string | undefined, orderId: string, reason: string | null): Promise<OrderView> {
    return this.http.request({
      method: "POST",
      path: `/orders/${encodeURIComponent(orderId)}/cancel`,
      body: { reason },
      ...(token ? { token } : {}),
    });
  }
}
