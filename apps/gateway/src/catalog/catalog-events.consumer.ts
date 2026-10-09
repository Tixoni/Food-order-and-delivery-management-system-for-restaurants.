import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Kafka, type Consumer } from "kafkajs";
import { CATALOG_EVENT_TYPES, TOPICS, type CatalogEventBase } from "@food-delivery/contracts";
import {
  createLogger,
  parseEvent,
  runWithContext,
  type DomainEvent,
  type Logger,
} from "@food-delivery/shared";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import { CatalogCache } from "./catalog.cache";

/**
 * Приём событий каталога и сброс кэша по ним — вторая половина CAT-4.
 *
 * Менеджер убрал блюдо в стоп-лист → каталог записал событие в исходящие
 * сообщения одной транзакцией с изменением → отправщик положил его
 * в брокер → этот потребитель сбросил кэш шлюза. Цепочка целиком занимает
 * меньше секунды, и ни одно её звено не теряет событие при сбое.
 *
 * Любое событие сбрасывает кэш соответствующего ресторана. События
 * ресторана и зоны дополнительно сбрасывают общие списки, которые не
 * привязаны к одному ресторану в ключе Redis.
 */
@Injectable()
export class CatalogEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: Logger;
  private readonly kafka: Kafka;
  private consumer: Consumer | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private stopped = false;

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly cache: CatalogCache,
  ) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "catalog-events",
    });

    this.kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      retry: { initialRetryTime: 300, retries: 3 },
      logCreator: () => () => {},
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.connect();
    if (!this.consumer) {
      // Старт Gateway при выключенном брокере не должен навсегда
      // отключать событийный сброс после восстановления Kafka.
      this.retryTimer = setInterval(() => void this.connect(), 5000);
      this.retryTimer.unref?.();
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.consumer || this.stopped) return;
    this.connecting = true;
    let consumer: Consumer | null = null;
    try {
      consumer = this.kafka.consumer({ groupId: this.config.kafka.groupId });
      await consumer.connect();
      await consumer.subscribe({ topic: TOPICS.catalog, fromBeginning: false });

      await consumer.run({
        eachMessage: async ({ message }) => {
          await this.handle(message.value?.toString("utf8"));
        },
      });

      this.consumer = consumer;
      if (this.retryTimer) clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.logger.info("подписка на события каталога установлена", {
        topic: TOPICS.catalog,
        group: this.config.kafka.groupId,
      });
    } catch (error) {
      // Без брокера шлюз продолжает работать: кэш будет обновляться
      // по истечении срока жизни записей, медленнее, но верно.
      this.logger.warn("не удалось подписаться на события каталога", {
        error: error instanceof Error ? error.message : String(error),
      });
      await consumer?.disconnect().catch(() => undefined);
    } finally {
      this.connecting = false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    await this.consumer?.disconnect().catch(() => undefined);
    this.consumer = null;
  }

  private async handle(raw: string | undefined): Promise<void> {
    if (!raw) return;

    let event: DomainEvent<CatalogEventBase>;
    try {
      event = parseEvent<CatalogEventBase>(JSON.parse(raw));
    } catch (error) {
      // Неразобранное сообщение не должно останавливать чтение топика:
      // иначе одно испорченное сообщение заморозит обновление кэша.
      this.logger.warn("событие каталога не разобрано", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const restaurantId = event.payload?.restaurantId;
    if (!restaurantId) return;

    // Обработка продолжает тот же сквозной идентификатор, с которым
    // пользователь нажал кнопку в панели менеджера (OBS-1, OBS-2).
    await runWithContext({ correlationId: event.correlationId, source: "kafka" }, async () => {
      await this.cache.invalidateRestaurant(restaurantId);
      if (
        event.eventType === CATALOG_EVENT_TYPES.restaurantChanged ||
        event.eventType === CATALOG_EVENT_TYPES.deliveryZoneChanged
      ) {
        await this.cache.invalidateListings();
      }
      this.logger.debug("кэш сброшен по событию", {
        eventType: event.eventType,
        restaurantId,
      });
    });
  }
}
