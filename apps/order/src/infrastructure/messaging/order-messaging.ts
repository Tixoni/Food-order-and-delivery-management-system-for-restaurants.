import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { TOPICS, deadLetterTopic, type TopicName } from "@food-delivery/contracts";
import { createLogger, type DomainEvent } from "@food-delivery/shared";
import { OutboxRelay, ReliableConsumer, type SqlTransaction } from "@food-delivery/service-kit";
import { ParticipantEventsUseCase } from "../../application/use-cases/participant-events.use-case";
import { ORDER_CONFIG, type OrderConfig } from "../../config/configuration";

/**
 * Отправка событий заказа в брокер — вторая половина Transactional Outbox.
 * Сам механизм общий для всех сервисов и живёт в каркасе.
 */
@Injectable()
export class OrderOutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    @Inject(ORDER_CONFIG) config: OrderConfig,
  ) {
    const transaction: SqlTransaction = (work) =>
      dataSource.transaction((manager) =>
        work((sql, parameters) => manager.query(sql, parameters as unknown[])),
      );
    this.relay = new OutboxRelay({
      topic: TOPICS.order,
      kafka: { brokers: config.kafka.brokers, clientId: config.kafka.clientId },
      pollIntervalMs: config.outbox.pollIntervalMs,
      batchSize: config.outbox.batchSize,
      transaction,
      logger: createLogger({ service: "order", level: config.logLevel }).child({
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

/**
 * Приём событий участников саги: платежей и доставки.
 * Повторы, очередь необработанных и переподключение — в общем потребителе
 * каркаса; защита от повторной обработки — в сценарии (inbox).
 */
@Injectable()
export class ParticipantEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer: ReliableConsumer;

  constructor(
    @Inject(ORDER_CONFIG) config: OrderConfig,
    private readonly participants: ParticipantEventsUseCase,
  ) {
    this.consumer = new ReliableConsumer({
      kafka: { brokers: config.kafka.brokers, clientId: config.kafka.clientId },
      groupId: config.kafka.groupId,
      topics: [TOPICS.payment, TOPICS.delivery],
      deadLetterTopic: (topic) => deadLetterTopic(topic as TopicName),
      handle: (event, meta) => this.route(event, meta.topic),
      retry: { attempts: 5, baseDelayMs: 200, maxDelayMs: 5000 },
      logger: createLogger({ service: "order", level: config.logLevel }).child({
        component: "participant-events",
      }),
    });
  }

  onApplicationBootstrap() {
    return this.consumer.start();
  }

  onApplicationShutdown() {
    return this.consumer.stop();
  }

  private async route(event: DomainEvent, topic: string): Promise<void> {
    if (topic === TOPICS.payment) {
      await this.participants.onPaymentEvent(event as DomainEvent<never>);
    } else if (topic === TOPICS.delivery) {
      await this.participants.onDeliveryEvent(event as DomainEvent<never>);
    }
  }
}
