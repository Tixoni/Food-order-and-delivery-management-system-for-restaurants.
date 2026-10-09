import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createLogger, type Logger } from "@food-delivery/shared";
import { MetricsService, ResilientRedisClient } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/**
 * Кэш выдачи каталога на шлюзе.
 *
 * Это второй, внешний кэш: первый живёт в самом каталоге. Разделение
 * не избыточно — они закрывают разные расходы. Кэш каталога снимает
 * нагрузку с базы, кэш шлюза снимает сетевой вызов между сервисами
 * и сборку ответа для экрана.
 *
 * При изменении меню кэши сбрасываются локально и по событию. Короткий
 * срок жизни обеих ступеней ограничивает устаревание при потере события;
 * измерение CAT-4 под нагрузкой всё равно остаётся обязательным.
 */
@Injectable()
export class CatalogCache implements OnApplicationShutdown {
  private readonly redis: ResilientRedisClient;
  private readonly logger: Logger;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
    private readonly metrics: MetricsService,
  ) {
    // Ограничение важно для CAT-4 и служит страховкой при потере
    // события, которое сбрасывает общие списки.
    this.ttlSeconds = Math.min(config.redis.cacheTtlSeconds, 2);
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "catalog-cache",
    });

    this.redis = new ResilientRedisClient({
      host: config.redis.host,
      port: config.redis.port,
      commandTimeoutMs: 200,
      onError: (error) => this.logger.warn("кэш недоступен", { error: error.message }),
    });
  }

  /**
   * Читает из кэша или получает значение и кладёт его туда.
   *
   * Недоступность кэша не должна ломать выдачу: любая ошибка Redis здесь
   * означает «в кэше ничего нет», и запрос идёт в сервис. Ответ будет
   * медленнее, но будет.
   */
  async through<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached !== null) return cached;

    const value = await load();
    await this.write(key, value);

    return value;
  }

  /** Сброс всего, что относится к ресторану: по событию об изменении меню. */
  async invalidateRestaurant(restaurantId: string): Promise<void> {
    const key = this.setKey(restaurantId);

    const client = this.redis.readyClient;
    if (!client) return;

    try {
      // Ключи ресторана перечислены в отдельном множестве, а не ищутся
      // перебором по образцу: перебор просматривает всё пространство ключей
      // и на рабочей нагрузке останавливает Redis.
      const keys = await client.smembers(key);
      if (keys.length > 0) {
        await client.del(...keys, key);
      }

      this.logger.debug("кэш ресторана сброшен", { restaurantId, keys: keys.length });
    } catch (error) {
      this.logger.warn("не удалось сбросить кэш ресторана", {
        restaurantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Сброс общих списков после правки ресторана или зоны доставки. */
  async invalidateListings(): Promise<void> {
    const indexKey = "gateway:listings:keys";
    const client = this.redis.readyClient;
    if (!client) return;
    try {
      const keys = await client.smembers(indexKey);
      if (keys.length > 0) await client.del(...keys, indexKey);
      this.logger.debug("общие списки сброшены", { keys: keys.length });
    } catch (error) {
      this.logger.warn("не удалось сбросить общие списки", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Ключ выдачи, относящейся к конкретному ресторану. */
  restaurantKey(restaurantId: string, suffix: string): string {
    return `gateway:restaurant:${restaurantId}:${suffix}`;
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }

  private async read<T>(key: string): Promise<T | null> {
    const client = this.redis.readyClient;
    if (!client) {
      this.metrics.cacheReads.labels(this.cacheName(key), "error").inc();
      return null;
    }
    try {
      const raw = await client.get(key);
      const value = raw ? (JSON.parse(raw) as T) : null;
      this.metrics.cacheReads.labels(this.cacheName(key), value !== null ? "hit" : "miss").inc();
      return value;
    } catch {
      this.metrics.cacheReads.labels(this.cacheName(key), "error").inc();
      return null;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    const client = this.redis.readyClient;
    if (!client) return;
    try {
      const pipeline = client.multi().set(key, JSON.stringify(value), "EX", this.ttlSeconds);

      // Ключ, относящийся к ресторану, запоминается в его множестве —
      // чтобы потом сбросить всё разом по событию.
      const restaurantId = key.startsWith("gateway:restaurant:") ? key.split(":")[2] : undefined;

      if (restaurantId) {
        pipeline
          .sadd(this.setKey(restaurantId), key)
          // Множество живёт дольше записей: иначе оно исчезнет раньше них
          // и сбрасывать будет нечего.
          .expire(this.setKey(restaurantId), this.ttlSeconds * 2);
      } else if (key.startsWith("gateway:restaurants:") || key.startsWith("gateway:nearby:")) {
        pipeline
          .sadd("gateway:listings:keys", key)
          .expire("gateway:listings:keys", this.ttlSeconds * 2);
      }

      await pipeline.exec();
    } catch {
      // Незаписанный кэш — не ошибка запроса: ответ уже получен.
    }
  }

  private setKey(restaurantId: string): string {
    return `gateway:restaurant:${restaurantId}:keys`;
  }

  private cacheName(key: string): string {
    return key.startsWith("gateway:restaurant:") ? "menu" : "listing";
  }
}
