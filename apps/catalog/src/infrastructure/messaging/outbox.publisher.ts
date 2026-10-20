import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { TOPICS } from "@food-delivery/contracts";
import { createLogger } from "@food-delivery/shared";
import { OutboxRelay, type SqlTransaction } from "@food-delivery/service-kit";
import { CATALOG_CONFIG, type CatalogConfig } from "../../config/configuration";

/**
 * Отправка накопленных событий каталога в брокер — вторая половина
 * Transactional Outbox.
 *
 * Сам механизм — выборка с `FOR UPDATE SKIP LOCKED`, отправка, отметка
 * о публикации, повтор подготовки топика после недоступности брокера —
 * общий для всех сервисов и живёт в каркасе (`OutboxRelay`). Здесь только
 * подключение: топик каталога и транзакция базы каталога.
 *
 * Запрос менеджера завершается, как только событие записано в базу,
 * и не ждёт брокера: если брокер лежит, каталог продолжает работать,
 * а события уходят после восстановления (REL-3).
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    @Inject(CATALOG_CONFIG) config: CatalogConfig,
  ) {
    const transaction: SqlTransaction = (work) =>
      dataSource.transaction((manager) =>
        work((sql, parameters) => manager.query(sql, parameters as unknown[])),
      );
    this.relay = new OutboxRelay({
      topic: TOPICS.catalog,
      kafka: config.kafka,
      pollIntervalMs: config.outbox.pollIntervalMs,
      batchSize: config.outbox.batchSize,
      transaction,
      logger: createLogger({ service: "catalog", level: config.logLevel }).child({
        component: "outbox",
      }),
    });
  }

  onApplicationBootstrap(): Promise<void> {
    return this.relay.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.relay.stop();
  }
}
