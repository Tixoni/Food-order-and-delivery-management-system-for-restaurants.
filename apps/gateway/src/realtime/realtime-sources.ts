import { hostname } from "node:os";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import Redis from "ioredis";
import {
  DELIVERY_EVENT_TYPES,
  ORDER_EVENT_TYPES,
  TOPICS,
  deadLetterTopic,
  type TopicName,
  type CourierAssignedPayload,
  type DeliveryEventBase,
  type OrderStatusChangedPayload,
} from "@food-delivery/contracts";
import { createLogger, type DomainEvent, type Logger } from "@food-delivery/shared";
import { ReliableConsumer } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import { EventHub, channels } from "./event-hub";

/** Обновление статуса заказа для подписчиков. */
export interface OrderUpdate {
  orderId: string;
  restaurantId: string;
  status: string;
  previousStatus: string | null;
  at: string;
}

/** Событие для курьера: что-то изменилось — перечитать экран. */
export interface CourierSignal {
  courierId: string;
  kind: string;
  orderId: string;
  at: string;
}

/**
 * События заказов и доставки из брокера → подписчики этого экземпляра.
 *
 * У каждого экземпляра шлюза своя группа потребителей: событие должно
 * дойти до всех экземпляров, ведь клиент заказа может быть подключён
 * к любому из них. Это отличается от сброса кэша каталога, где одной
 * доставки на группу достаточно, — там кэш общий.
 */
@Injectable()
export class RealtimeEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer: ReliableConsumer;

  constructor(
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
    private readonly hub: EventHub,
  ) {
    const logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "realtime-events",
    });
    this.consumer = new ReliableConsumer({
      kafka: { brokers: config.kafka.brokers, clientId: `${config.kafka.clientId}-push` },
      // Новый экземпляр начинает с текущего момента: история не нужна,
      // клиент при подключении получает свежее состояние запросом.
      groupId: `gateway-push-${hostname()}-${process.pid}`,
      topics: [TOPICS.order, TOPICS.delivery],
      deadLetterTopic: (topic) => deadLetterTopic(topic as TopicName),
      handle: async (event) => this.dispatch(event),
      retry: { attempts: 1, baseDelayMs: 50, maxDelayMs: 50 },
      logger,
    });
  }

  onApplicationBootstrap() {
    return this.consumer.start();
  }

  onApplicationShutdown() {
    return this.consumer.stop();
  }

  /** Разбор события и раздача по каналам. Открыт для тестов. */
  dispatch(event: DomainEvent): void {
    if (event.eventType === ORDER_EVENT_TYPES.statusChanged) {
      const payload = event.payload as OrderStatusChangedPayload;
      const update: OrderUpdate = {
        orderId: payload.orderId,
        restaurantId: payload.restaurantId,
        status: payload.to,
        previousStatus: payload.from,
        at: payload.changedAt,
      };
      this.hub.emit(channels.order(payload.orderId), update);
      this.hub.emit(channels.kitchen(payload.restaurantId), update);
      return;
    }

    const courierEvents: string[] = [
      DELIVERY_EVENT_TYPES.courierAssigned,
      DELIVERY_EVENT_TYPES.courierAccepted,
      DELIVERY_EVENT_TYPES.orderPickedUp,
      DELIVERY_EVENT_TYPES.deliveryCompleted,
    ];
    if (courierEvents.includes(event.eventType)) {
      const payload = event.payload as DeliveryEventBase & Partial<CourierAssignedPayload>;
      if (!payload.courierId) return;
      const signal: CourierSignal = {
        courierId: payload.courierId,
        kind: event.eventType,
        orderId: payload.orderId,
        at: event.occurredAt,
      };
      this.hub.emit(channels.courier(payload.courierId), signal);
    }
  }
}

/**
 * Позиции курьеров из канала публикации Redis → подписчики заказа.
 *
 * Координата в брокер не попадает: это телеметрия, а не доменное событие.
 * Доставка публикует её в `ws:order:{orderId}`, шлюз слушает все такие
 * каналы по шаблону и пересылает только тем, кто подписан на этот заказ.
 * Отдельное соединение: в режиме подписки Redis не выполняет других команд.
 */
@Injectable()
export class PositionRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: Logger;
  private subscriber: Redis | null = null;

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly hub: EventHub,
  ) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "position-relay",
    });
  }

  onApplicationBootstrap() {
    const subscriber = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      // Переподключение без конца: недоступный Redis — временное состояние.
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
      lazyConnect: true,
    });
    subscriber.on("error", (error) =>
      this.logger.debug("канал позиций недоступен", { error: error.message }),
    );
    subscriber.on("pmessage", (_pattern, channel, message) => {
      const orderId = channel.slice("ws:order:".length);
      // Никого нет — нечего и разбирать.
      if (this.hub.subscribers(channels.position(orderId)) === 0) return;
      try {
        this.hub.emit(channels.position(orderId), JSON.parse(message));
      } catch {
        this.logger.warn("позиция не разобрана", { channel });
      }
    });
    subscriber.on("ready", () => {
      void subscriber.psubscribe("ws:order:*");
    });
    void subscriber.connect().catch(() => undefined);
    this.subscriber = subscriber;
  }

  onApplicationShutdown() {
    this.subscriber?.disconnect();
  }
}
