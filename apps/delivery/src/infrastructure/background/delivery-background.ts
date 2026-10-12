import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { TOPICS } from "@food-delivery/contracts";
import { createLogger, type Logger } from "@food-delivery/shared";
import { OutboxRelay, type SqlTransaction } from "@food-delivery/service-kit";
import { DispatchUseCase } from "../../application/use-cases/dispatch.use-case";
import { DELIVERY_CONFIG, type DeliveryConfig } from "../../config/configuration";

/**
 * Отправка событий доставки в брокер — вторая половина Transactional
 * Outbox (REL-3). Механизм общий и живёт в каркасе.
 */
@Injectable()
export class DeliveryOutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    @Inject(DELIVERY_CONFIG) config: DeliveryConfig,
  ) {
    const transaction: SqlTransaction = (work) =>
      dataSource.transaction((manager) =>
        work((sql, parameters) => manager.query(sql, parameters as unknown[])),
      );
    this.relay = new OutboxRelay({
      topic: TOPICS.delivery,
      kafka: config.kafka,
      pollIntervalMs: config.outbox.pollIntervalMs,
      batchSize: config.outbox.batchSize,
      transaction,
      logger: createLogger({ service: "delivery", level: config.logLevel }).child({
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
 * Таймер отклика на предложение (DLV-4). Срок хранится в строке
 * предложения, поэтому перезапуск сервиса таймер не теряет: после старта
 * опрос подхватывает всё, что истекло за время простоя (REL-6).
 * Несколько экземпляров сервиса не мешают друг другу: просроченные
 * предложения выбираются с пропуском заблокированных строк.
 */
@Injectable()
export class OfferTimeoutScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly logger: Logger;

  constructor(
    private readonly dispatch: DispatchUseCase,
    @Inject(DELIVERY_CONFIG) private readonly config: DeliveryConfig,
  ) {
    this.logger = createLogger({ service: "delivery", level: config.logLevel }).child({
      component: "offer-timeouts",
    });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.config.dispatch.sweepIntervalMs);
    this.timer.unref?.();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const expired = await this.dispatch.expireOffers();
      if (expired > 0)
        this.logger.info("предложения истекли, заказ предложен следующим", { expired });
    } catch (error) {
      this.logger.warn("проверка сроков предложений не выполнена", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
    }
  }
}
