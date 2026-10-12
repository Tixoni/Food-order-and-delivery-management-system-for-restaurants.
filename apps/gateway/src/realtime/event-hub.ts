import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";
import { Gauge } from "prom-client";
import { MetricsService } from "@food-delivery/service-kit";

/** Каналы реального времени шлюза. */
export const channels = {
  /** Статус заказа — клиенту на экран отслеживания (TRK-1, NTF-1). */
  order: (orderId: string) => `order:${orderId}`,
  /** Позиция курьера заказа (TRK-2). */
  position: (orderId: string) => `position:${orderId}`,
  /** Очередь кухни ресторана изменилась (KIT-1). */
  kitchen: (restaurantId: string) => `kitchen:${restaurantId}`,
  /** Курьеру что-то предложили или сняли (DLV-4). */
  courier: (courierId: string) => `courier:${courierId}`,
};

/** Сколько непрочитанных событий держится для одного подписчика. */
const MAX_BUFFERED = 100;

/**
 * Раздача событий подписчикам этого экземпляра шлюза.
 *
 * Источник событий — брокер и канал публикации Redis, а не память
 * процесса: каждый экземпляр шлюза получает все события сам (у каждого
 * свой потребитель), поэтому клиент получит обновление, к какому бы
 * экземпляру ни было подключено его соединение (SCAL-2).
 *
 * Подписка — асинхронный итератор: GraphQL-подписка забирает события
 * по одному, а когда клиент отключается, итератор закрывается и снимает
 * свой обработчик. Медленному клиенту копится не больше сотни событий —
 * старые вытесняются, память не растёт.
 */
@Injectable()
export class EventHub {
  private readonly emitter = new EventEmitter();
  private readonly active: Gauge<"kind">;

  constructor(metrics: MetricsService) {
    // Тысячи подписчиков на разных каналах — штатная работа, а не утечка.
    this.emitter.setMaxListeners(0);
    this.active = new Gauge({
      name: "realtime_subscriptions",
      help: "Открытые подписки реального времени (SCAL-4)",
      labelNames: ["kind"],
      registers: [metrics.registry],
    });
  }

  emit(channel: string, payload: unknown): void {
    this.emitter.emit(channel, payload);
  }

  subscribers(channel: string): number {
    return this.emitter.listenerCount(channel);
  }

  listen<T>(channel: string): AsyncIterableIterator<T> {
    const kind = channel.split(":")[0];
    const queue: T[] = [];
    let waiting: ((result: IteratorResult<T>) => void) | null = null;
    let closed = false;

    const handler = (payload: T) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: payload, done: false });
        return;
      }
      queue.push(payload);
      if (queue.length > MAX_BUFFERED) queue.shift();
    };

    const close = () => {
      if (closed) return;
      closed = true;
      this.emitter.off(channel, handler);
      this.active.labels(kind).dec();
      waiting?.({ value: undefined, done: true });
      waiting = null;
    };

    this.emitter.on(channel, handler);
    this.active.labels(kind).inc();

    const iterator: AsyncIterableIterator<T> = {
      next: () => {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      return: () => {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error: unknown) => {
        close();
        return Promise.reject(error);
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }
}
