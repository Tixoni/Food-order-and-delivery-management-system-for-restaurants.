import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { createLogger } from "@food-delivery/shared";
import {
  AuthModule,
  INTERNAL_TOKEN_HEADER,
  InternalHttpClient,
  ServiceKitModule,
} from "@food-delivery/service-kit";
import { ORDER_CONFIG, loadConfig, type OrderConfig } from "./config/configuration";
import { CART_STORE } from "./application/ports/cart.store";
import { CLOCK, systemClock } from "./application/ports/clock";
import { ORDER_READ_MODEL } from "./application/ports/order-read-model";
import { ORDER_REPOSITORY, type OrderRepository } from "./application/ports/order.repository";
import { CATALOG_PORT, DELIVERY_PORT, PAYMENT_PORT } from "./application/ports/participants";
import { SAGA_QUEUE } from "./application/ports/saga-queue";
import { ORDER_COMMITTER, OrderCommitter } from "./application/saga/order-committer";
import { ORDER_WORKFLOW, OrderWorkflow } from "./application/saga/order-workflow";
import { SagaRunner } from "./application/saga/saga-runner";
import { SAGA_SETTINGS } from "./application/saga/saga-settings";
import { CartUseCases } from "./application/use-cases/cart.use-cases";
import { OrderCommandsUseCase } from "./application/use-cases/order-commands.use-case";
import { OrderQueriesUseCase } from "./application/use-cases/order-queries.use-case";
import { ParticipantEventsUseCase } from "./application/use-cases/participant-events.use-case";
import { PlaceOrderUseCase } from "./application/use-cases/place-order.use-case";
import { RedisCartStore } from "./infrastructure/cache/redis-cart.store";
import {
  CatalogHttpClient,
  DeliveryHttpClient,
  PaymentHttpClient,
} from "./infrastructure/external/participant.clients";
import { DeliveryStub, PaymentStub } from "./infrastructure/external/participant.stubs";
import {
  OrderOutboxPublisher,
  ParticipantEventsConsumer,
} from "./infrastructure/messaging/order-messaging";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { TypeOrmOrderReadModel } from "./infrastructure/persistence/typeorm-order-read-model";
import { TypeOrmOrderRepository } from "./infrastructure/persistence/typeorm-order.repository";
import { SagaScheduler } from "./infrastructure/scheduler/saga-scheduler";
import { CartController } from "./interface/http/cart.controller";
import { KitchenController } from "./interface/http/kitchen.controller";
import { OperatorController } from "./interface/http/operator.controller";
import { OrdersController } from "./interface/http/orders.controller";

const config = loadConfig();

/**
 * Синхронный клиент соседнего сервиса: таймаут, повторы, размыкатель цепи.
 * Отдельный экземпляр на каждого соседа — у каждого своя цепь: отказ
 * платежей не должен размыкать вызовы каталога.
 */
const httpClient = (
  name: string,
  baseUrl: string,
  cfg: OrderConfig,
  headers?: Record<string, string>,
) =>
  new InternalHttpClient({
    name,
    baseUrl,
    headers,
    timeoutMs: cfg.services.timeoutMs,
    breaker: cfg.services.breaker,
    retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    logger: createLogger({ service: "order", level: cfg.logLevel }).child({
      component: `${name}-client`,
    }),
  });

@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "order",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    // Проверка входа и ролей на каждом запросе (SEC-2): обработчики закрыты
    // по умолчанию; владение заказом проверяют сценарии.
    AuthModule.forRoot(config.auth),
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      // Запросы заказа написаны на SQL (см. order.rows.ts): ORM ведёт
      // подключение и транзакции, сущности ему не нужны.
      entities: [],
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
  ],
  controllers: [OrdersController, KitchenController, OperatorController, CartController],
  providers: [
    { provide: ORDER_CONFIG, useValue: config },
    { provide: SAGA_SETTINGS, useValue: config.saga },
    { provide: CLOCK, useValue: systemClock },
    { provide: ORDER_WORKFLOW, useValue: new OrderWorkflow(config.saga.timeouts) },

    // Хранилище: одна реализация закрывает три порта — запись, очередь саги
    // и чтение идут в одну базу заказа.
    TypeOrmOrderRepository,
    { provide: ORDER_REPOSITORY, useExisting: TypeOrmOrderRepository },
    { provide: SAGA_QUEUE, useExisting: TypeOrmOrderRepository },
    { provide: ORDER_READ_MODEL, useClass: TypeOrmOrderReadModel },
    { provide: CART_STORE, useClass: RedisCartStore },
    {
      provide: ORDER_COMMITTER,
      useFactory: (repository: OrderRepository, workflow: OrderWorkflow) =>
        new OrderCommitter(repository, workflow),
      inject: [ORDER_REPOSITORY, ORDER_WORKFLOW],
    },

    // Участники саги. Платежи — сервис `payment` (PAYMENT_MODE=http) или
    // заглушка внутри процесса для разработки без него; доставка — заглушка
    // до итерации 3. Переключение — PAYMENT_MODE / DELIVERY_MODE.
    {
      provide: CATALOG_PORT,
      useValue: new CatalogHttpClient(httpClient("catalog", config.services.catalogUrl, config)),
    },
    {
      provide: PAYMENT_PORT,
      useValue:
        config.services.payment.mode === "http"
          ? new PaymentHttpClient(
              // Операции с деньгами платёжный сервис выполняет только
              // по служебному токену.
              httpClient("payment", config.services.payment.url, config, {
                [INTERNAL_TOKEN_HEADER]: config.services.payment.internalToken,
              }),
            )
          : new PaymentStub(config.paymentStub),
    },
    {
      provide: DELIVERY_PORT,
      useValue:
        config.services.delivery.mode === "http"
          ? new DeliveryHttpClient(httpClient("delivery", config.services.delivery.url, config))
          : new DeliveryStub(),
    },

    PlaceOrderUseCase,
    OrderCommandsUseCase,
    OrderQueriesUseCase,
    ParticipantEventsUseCase,
    CartUseCases,
    SagaRunner,

    // Фоновые процессы: исполнитель саги, отправка событий, приём событий.
    SagaScheduler,
    OrderOutboxPublisher,
    ParticipantEventsConsumer,
  ],
})
export class AppModule {}
