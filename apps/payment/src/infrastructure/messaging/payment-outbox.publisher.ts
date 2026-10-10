import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { TOPICS } from "@food-delivery/contracts";
import { createLogger } from "@food-delivery/shared";
import { OutboxRelay, type SqlTransaction } from "@food-delivery/service-kit";
import { PAYMENT_CONFIG, type PaymentConfig } from "../../config/configuration";

/**
 * Отправка событий платежей в брокер — вторая половина Transactional Outbox
 * (REL-3). Механизм общий для всех сервисов и живёт в каркасе.
 *
 * Сервис намеренно ничего не потребляет: он ведомый участник саги,
 * и всё, что ему нужно знать, приходит синхронным вызовом.
 */
@Injectable()
export class PaymentOutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    @Inject(PAYMENT_CONFIG) config: PaymentConfig,
  ) {
    const transaction: SqlTransaction = (work) =>
      dataSource.transaction((manager) =>
        work((sql, parameters) => manager.query(sql, parameters as unknown[])),
      );
    this.relay = new OutboxRelay({
      topic: TOPICS.payment,
      kafka: config.kafka,
      pollIntervalMs: config.outbox.pollIntervalMs,
      batchSize: config.outbox.batchSize,
      transaction,
      logger: createLogger({ service: "payment", level: config.logLevel }).child({
        component: "outbox",
      }),
    });
  }

  onApplicationBootstrap() {
    return this.relay.start();
  }

  onApplicationShutdown() {
    return this.relay.stop();
  }
}
