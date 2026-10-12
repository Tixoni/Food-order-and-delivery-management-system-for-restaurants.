import { Inject, Injectable } from "@nestjs/common";
import { createLogger, type Logger } from "@food-delivery/shared";
import { CatalogCache } from "../catalog/catalog.cache";
import { CatalogClient } from "../catalog/catalog.client";
import type { RestaurantView } from "../catalog/catalog.views";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/** Контекст одного запроса GraphQL: здесь живёт кэш ресторанов этого запроса. */
export interface LookupContext {
  restaurants?: Map<string, Promise<RestaurantView | null>>;
}

/**
 * Ресторан по идентификатору для вложенных полей — заказа, доставки курьера.
 *
 * В истории двадцать заказов чаще всего из двух-трёх ресторанов: в пределах
 * одного запроса каждый ресторан запрашивается один раз, между запросами —
 * берётся из общего кэша каталога. Каталог недоступен — `null`, а не ошибка:
 * экран заказа важнее подписи на нём (REL-2).
 */
@Injectable()
export class RestaurantLookup {
  private readonly logger: Logger;

  constructor(
    private readonly catalog: CatalogClient,
    private readonly cache: CatalogCache,
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
  ) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "restaurant-lookup",
    });
  }

  find(restaurantId: string | null | undefined, context: LookupContext) {
    if (!restaurantId) return Promise.resolve(null);
    context.restaurants ??= new Map();
    let pending = context.restaurants.get(restaurantId);
    if (!pending) {
      pending = this.cache
        .through(this.cache.restaurantKey(restaurantId, "summary"), () =>
          this.catalog.restaurant(undefined, restaurantId),
        )
        .catch((error: unknown) => {
          this.logger.warn("ресторан не получен из каталога", {
            restaurantId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      context.restaurants.set(restaurantId, pending);
    }
    return pending;
  }
}
