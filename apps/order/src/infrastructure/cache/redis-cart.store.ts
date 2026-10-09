import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { ExternalServiceError, createLogger, type Logger } from "@food-delivery/shared";
import { ResilientRedisClient } from "@food-delivery/service-kit";
import type { Cart, CartStore } from "../../application/ports/cart.store";
import { ORDER_CONFIG, type OrderConfig } from "../../config/configuration";

const key = (customerId: string) => `cart:${customerId}`;

/**
 * Корзина в Redis: ключ `cart:{customerId}`, срок жизни — сутки.
 *
 * Недоступность кэша — ожидаемое состояние, а не авария: корзина временно
 * недоступна, но оформление заказа с явным списком позиций работает,
 * и ни каталог, ни заказы из-за Redis не падают (REL-2).
 */
@Injectable()
export class RedisCartStore implements CartStore, OnApplicationShutdown {
  private readonly logger: Logger;
  private readonly redis: ResilientRedisClient;

  constructor(@Inject(ORDER_CONFIG) private readonly config: OrderConfig) {
    this.logger = createLogger({ service: "order", level: config.logLevel }).child({
      component: "cart",
    });
    this.redis = new ResilientRedisClient({
      host: config.redis.host,
      port: config.redis.port,
      commandTimeoutMs: 500,
      onError: (error) => this.logger.debug("redis недоступен", { error: error.message }),
    });
  }

  onApplicationShutdown() {
    this.redis.disconnect();
  }

  async get(customerId: string): Promise<Cart | null> {
    const raw = await this.client().get(key(customerId));
    return raw ? (JSON.parse(raw) as Cart) : null;
  }

  async save(cart: Cart): Promise<void> {
    await this.client().set(
      key(cart.customerId),
      JSON.stringify(cart),
      "EX",
      this.config.redis.cartTtlSeconds,
    );
  }

  async clear(customerId: string): Promise<void> {
    await this.client().del(key(customerId));
  }

  private client() {
    const client = this.redis.readyClient;
    if (!client) throw new ExternalServiceError("корзина временно недоступна, повторите позже");
    return client;
  }
}
