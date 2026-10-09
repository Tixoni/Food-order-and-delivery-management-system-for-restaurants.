import { Inject, Injectable } from "@nestjs/common";
import { createLogger } from "@food-delivery/shared";
import { InternalHttpClient } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import type {
  DeliveryZoneView,
  MenuItemView,
  MenuSectionView,
  RestaurantDetailsView,
  RestaurantOfferView,
  RestaurantView,
  StopListEntryView,
} from "./catalog.views";

/**
 * Обращение шлюза к сервису каталога.
 *
 * Три решения, которые стоит назвать прямо.
 *
 * Первое: сквозной идентификатор и токен передаются дальше без изменений.
 * Идентификатор — чтобы записи журнала шлюза и каталога об одном действии
 * пользователя находились одним запросом (OBS-1). Токен — потому что права
 * проверяет тот сервис, который владеет данными; шлюз, решающий за каталог,
 * кто что может, рано или поздно разойдётся с ним в правилах (SEC-2).
 *
 * Второе: ошибка соседнего сервиса не превращается во «внутреннюю ошибку».
 * Каталог отвечает в общем формате ошибок, и шлюз этот формат сохраняет:
 * иначе «ресторан не найден» дошло бы до клиента как сбой системы.
 *
 * Третье: вызов идёт через общий устойчивый клиент каркаса — таймаут,
 * повтор чтения при кратковременном сбое и размыкатель цепи. Если каталог
 * лёг, шлюз не копит зависшие запросы до таймаута, а сразу отвечает
 * «временно недоступен»; закэшированное меню при этом продолжает отдаваться.
 * Изменяющие вызовы (стоп-лист, меню) не повторяются: у них нет ключа
 * идемпотентности, и повтор мог бы выполнить действие дважды.
 */
@Injectable()
export class CatalogClient {
  private readonly http: InternalHttpClient;

  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) {
    this.http = new InternalHttpClient({
      name: "catalog",
      baseUrl: config.services.catalog,
      timeoutMs: config.services.timeoutMs,
      retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 300 },
      breaker: { failureThreshold: 5, openDurationMs: 10_000 },
      logger: createLogger({ service: "gateway", level: config.logLevel }).child({
        component: "catalog-client",
      }),
    });
  }

  listRestaurants(
    token: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ items: RestaurantView[]; total: number; page: number; pageSize: number }> {
    return this.get(`/restaurants?page=${page}&pageSize=${pageSize}`, token);
  }

  /** CAT-1: рестораны, доставляющие по адресу. */
  deliveringTo(
    token: string | undefined,
    latitude: number,
    longitude: number,
    limit: number,
  ): Promise<{ items: RestaurantOfferView[]; total: number }> {
    return this.get(
      `/restaurants/delivery-to?lat=${latitude}&lon=${longitude}&limit=${limit}`,
      token,
    );
  }

  /** CAT-2: меню ресторана. */
  menu(
    token: string | undefined,
    restaurantId: string,
    includeUnavailable: boolean,
  ): Promise<{ restaurantId: string; categories: MenuSectionView[] }> {
    return this.get(
      `/restaurants/${encodeURIComponent(restaurantId)}/menu` +
        (includeUnavailable ? "?includeUnavailable=true" : ""),
      token,
    );
  }

  stopList(
    token: string | undefined,
    restaurantId: string,
    limit: number,
  ): Promise<{ restaurantId: string; entries: StopListEntryView[] }> {
    return this.get(
      `/restaurants/${encodeURIComponent(restaurantId)}/stop-list?limit=${limit}`,
      token,
    );
  }

  /** CAT-4: перевод блюда в стоп-лист и обратно. */
  setAvailability(
    token: string | undefined,
    itemId: string,
    body: { restaurantId: string; isAvailable: boolean; reason?: string | null },
  ): Promise<{ item: { id: string; isAvailable: boolean }; changed: boolean }> {
    return this.send(
      "PATCH",
      `/menu/items/${encodeURIComponent(itemId)}/availability`,
      token,
      body,
    );
  }

  /** ADM-1: зоны доставки ресторана. */
  zones(
    token: string | undefined,
    restaurantId: string,
  ): Promise<{ restaurantId: string; zones: DeliveryZoneView[] }> {
    return this.get(`/restaurants/${encodeURIComponent(restaurantId)}/zones`, token);
  }

  /**
   * ADM-1: сохранение зоны. Запись без идентификатора создаётся,
   * с идентификатором — изменяется: для редактора карты это одно действие.
   */
  saveZone(
    token: string | undefined,
    input: {
      id?: string;
      restaurantId: string;
      name?: string;
      ring?: Array<{ latitude: number; longitude: number }>;
      deliveryFee?: number;
      minOrderAmount?: number;
      isActive?: boolean;
    },
  ): Promise<DeliveryZoneView> {
    const { id, restaurantId, ...rest } = input;

    return id
      ? this.send("PATCH", `/zones/${encodeURIComponent(id)}`, token, { ...rest, restaurantId })
      : this.send("POST", `/restaurants/${encodeURIComponent(restaurantId)}/zones`, token, rest);
  }

  /** CAT-5: создание и изменение блюда. */
  saveMenuItem(
    token: string | undefined,
    input: {
      id?: string;
      restaurantId: string;
      categoryId?: string;
      name?: string;
      price?: number;
      description?: string;
      composition?: string;
      imageUrl?: string;
      weightGrams?: number;
      calories?: number;
    },
  ): Promise<MenuItemView> {
    const { id, restaurantId, ...rest } = input;

    return id
      ? this.send("PATCH", `/menu/items/${encodeURIComponent(id)}`, token, {
          ...rest,
          restaurantId,
        })
      : this.send(
          "POST",
          `/restaurants/${encodeURIComponent(restaurantId)}/menu/items`,
          token,
          rest,
        );
  }

  /** ADM-2: регистрация ресторана. */
  registerRestaurant(token: string | undefined, input: object): Promise<RestaurantDetailsView> {
    return this.send("POST", "/restaurants", token, input);
  }

  /** ADM-2: правка сведений о ресторане. */
  updateRestaurant(
    token: string | undefined,
    restaurantId: string,
    input: object,
  ): Promise<RestaurantDetailsView> {
    return this.send("PATCH", `/restaurants/${encodeURIComponent(restaurantId)}`, token, input);
  }

  private get<T>(path: string, token: string | undefined): Promise<T> {
    return this.send<T>("GET", path, token);
  }

  private send<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Promise<T> {
    return this.http.request<T>({
      method,
      path,
      ...(token ? { token } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }
}
