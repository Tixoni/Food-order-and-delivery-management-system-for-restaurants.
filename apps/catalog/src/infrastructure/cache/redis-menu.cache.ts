import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createLogger, type Logger } from "@food-delivery/shared";
import { MetricsService, ResilientRedisClient } from "@food-delivery/service-kit";
import type { MenuCache } from "../../application/ports/menu-cache";
import type { MenuSection } from "../../domain/menu-category";
import { CATALOG_CONFIG, type CatalogConfig } from "../../config/configuration";
import { MenuCacheCodec } from "./menu-cache.codec";

/**
 * Кэш меню поверх Redis.
 *
 * Два решения, которые стоит назвать прямо:
 *
 * 1. Недоступность кэша не должна ронять выдачу меню. Любая ошибка Redis
 *    здесь означает «в кэше ничего нет»: сервис сходит в базу и ответит
 *    медленнее, но ответит. Кэш — ускорение, а не источник данных.
 *
 * 2. Ключи одного ресторана собраны под общим префиксом, и сброс идёт
 *    по списку известных вариантов, а не командой поиска по образцу:
 *    поиск по образцу просматривает всё пространство ключей и на рабочей
 *    нагрузке останавливает Redis.
 */

// Страховка на случай потерянного сброса: даже при недоступном брокере
// стоп-лист не должен оставаться устаревшим дольше пяти секунд (CAT-4).
const MENU_TTL_SECONDS = 2;

@Injectable()
export class RedisMenuCache implements MenuCache, OnApplicationShutdown {
  private readonly redis: ResilientRedisClient;
  private readonly logger: Logger;

  constructor(
    @Inject(CATALOG_CONFIG) config: CatalogConfig,
    private readonly metrics: MetricsService,
  ) {
    this.logger = createLogger({ service: "catalog", level: config.logLevel }).child({
      component: "menu-cache",
    });

    this.redis = new ResilientRedisClient({
      host: config.redis.host,
      port: config.redis.port,
      commandTimeoutMs: 200,
      onError: (error) => this.logger.warn("кэш меню недоступен", { error: error.message }),
    });
  }

  async read(restaurantId: string, includeUnavailable: boolean): Promise<MenuSection[] | null> {
    const client = this.redis.readyClient;
    if (!client) {
      this.metrics.cacheReads.labels("menu", "error").inc();
      return null;
    }
    try {
      const raw = await client.get(this.key(restaurantId, includeUnavailable));
      const value = raw ? MenuCacheCodec.decode(raw) : null;
      this.metrics.cacheReads.labels("menu", value ? "hit" : "miss").inc();
      return value;
    } catch (error) {
      this.metrics.cacheReads.labels("menu", "error").inc();
      this.logger.debug("чтение кэша не удалось, идём в базу", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async write(
    restaurantId: string,
    includeUnavailable: boolean,
    sections: MenuSection[],
  ): Promise<void> {
    const client = this.redis.readyClient;
    if (!client) return;
    try {
      await client.set(
        this.key(restaurantId, includeUnavailable),
        MenuCacheCodec.encode(sections),
        "EX",
        MENU_TTL_SECONDS,
      );
    } catch {
      // Незаписанный кэш — не ошибка запроса: меню уже собрано и будет отдано.
    }
  }

  async invalidate(restaurantId: string): Promise<void> {
    const client = this.redis.readyClient;
    if (!client) {
      this.logger.warn("не удалось сбросить кэш меню: Redis недоступен", { restaurantId });
      return;
    }
    try {
      await client.del(this.key(restaurantId, false), this.key(restaurantId, true));
    } catch (error) {
      // А вот это уже опасно: клиент продолжит видеть блюдо, которого нет
      // на кухне, до истечения срока жизни записи. Пишем предупреждение,
      // чтобы такое было видно в журнале.
      this.logger.warn("не удалось сбросить кэш меню", {
        restaurantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }

  private key(restaurantId: string, includeUnavailable: boolean): string {
    return `catalog:menu:${restaurantId}:${includeUnavailable ? "all" : "available"}`;
  }
}
