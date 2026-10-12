import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createLogger, type Logger } from "@food-delivery/shared";
import { ResilientRedisClient } from "@food-delivery/service-kit";
import type { Position, PositionCache } from "../../application/ports/positions";
import { DELIVERY_CONFIG, type DeliveryConfig } from "../../config/configuration";

const positionKey = (courierId: string) => `courier:loc:${courierId}`;
/** Канал заказа: шлюз подписан и пересылает позицию клиенту по WebSocket. */
export const orderChannel = (orderId: string) => `ws:order:${orderId}`;

/**
 * Актуальная позиция курьера в Redis и рассылка подписчикам заказа.
 *
 * Позиция живёт 60 секунд без обновлений: курьер, потерявший связь,
 * «устаревает» сам, и клиенту показывается «позиция устарела», а не точка,
 * где курьер был полчаса назад. Недоступность Redis не останавливает
 * доставку: координата всё равно попадёт в историю, подбор идёт по базе.
 */
@Injectable()
export class RedisPositions implements PositionCache, OnApplicationShutdown {
  private readonly redis: ResilientRedisClient;
  private readonly logger: Logger;
  private readonly ttlSeconds: number;

  constructor(@Inject(DELIVERY_CONFIG) config: DeliveryConfig) {
    this.ttlSeconds = config.locations.positionTtlSeconds;
    this.logger = createLogger({ service: "delivery", level: config.logLevel }).child({
      component: "positions",
    });
    this.redis = new ResilientRedisClient({
      host: config.redis.host,
      port: config.redis.port,
      commandTimeoutMs: 300,
      onError: (error) => this.logger.debug("redis недоступен", { error: error.message }),
    });
  }

  async save(courierId: string, position: Position): Promise<void> {
    const client = this.redis.readyClient;
    if (!client) return;
    try {
      await client
        .multi()
        .hset(positionKey(courierId), {
          lat: String(position.latitude),
          lon: String(position.longitude),
          at: position.at.toISOString(),
          ...(position.accuracy != null ? { accuracy: String(position.accuracy) } : {}),
        })
        .expire(positionKey(courierId), this.ttlSeconds)
        .exec();
    } catch (error) {
      this.logger.warn("позиция не сохранена в кэш", { error: errorText(error) });
    }
  }

  async get(courierId: string): Promise<Position | null> {
    const client = this.redis.readyClient;
    if (!client) return null;
    try {
      const value = await client.hgetall(positionKey(courierId));
      if (!value.lat) return null;
      return {
        latitude: Number(value.lat),
        longitude: Number(value.lon),
        at: new Date(value.at),
        accuracy: value.accuracy ? Number(value.accuracy) : null,
      };
    } catch {
      return null;
    }
  }

  async publish(orderId: string, payload: unknown): Promise<void> {
    try {
      await this.redis.readyClient?.publish(orderChannel(orderId), JSON.stringify(payload));
    } catch (error) {
      this.logger.warn("позиция не разослана", { error: errorText(error) });
    }
  }

  onApplicationShutdown() {
    this.redis.disconnect();
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
