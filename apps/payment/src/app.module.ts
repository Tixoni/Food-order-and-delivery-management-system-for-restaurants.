import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { createLogger } from "@food-delivery/shared";
import { INTERNAL_TOKEN, InternalTokenGuard, ServiceKitModule } from "@food-delivery/service-kit";
import { PAYMENT_CONFIG, loadConfig } from "./config/configuration";
import { PAYMENT_PROVIDER } from "./application/ports/payment-provider";
import { PAYMENT_REPOSITORY } from "./application/ports/payment.repository";
import { PaymentHistoryUseCase } from "./application/use-cases/payment-history.use-case";
import { PaymentOperationsUseCase } from "./application/use-cases/payment-operations.use-case";
import { YooKassaProvider } from "./infrastructure/external/yookassa.provider";
import { PaymentOutboxPublisher } from "./infrastructure/messaging/payment-outbox.publisher";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { SqlPaymentRepository } from "./infrastructure/persistence/sql-payment.repository";
import { PaymentReconciler } from "./infrastructure/scheduler/payment-reconciler";
import { PaymentsController } from "./interface/http/payments.controller";

const config = loadConfig();

/**
 * Сервис платежей — ведомый участник саги.
 *
 * Слои: domain — платёж и его автомат; application — операции и порты;
 * infrastructure — база, провайдер, брокер, сверка; interface — внутренний API.
 *
 * Пользовательской аутентификации здесь нет: сервис не принимает запросов
 * от людей. Внутренний API закрыт служебным токеном.
 */
@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "payment",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      // Запросы написаны на SQL (sql-payment.repository.ts): ORM ведёт
      // подключение и транзакции, сущности ему не нужны.
      entities: [],
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
  ],
  controllers: [PaymentsController],
  providers: [
    { provide: PAYMENT_CONFIG, useValue: config },
    { provide: INTERNAL_TOKEN, useValue: config.internalToken },
    InternalTokenGuard,

    { provide: PAYMENT_REPOSITORY, useClass: SqlPaymentRepository },
    {
      provide: PAYMENT_PROVIDER,
      useValue: new YooKassaProvider({
        baseUrl: config.provider.url,
        shopId: config.provider.shopId,
        secretKey: config.provider.secretKey,
        timeoutMs: config.provider.timeoutMs,
        retry: config.provider.retry,
        breaker: config.provider.breaker,
        logger: createLogger({ service: "payment", level: config.logLevel }).child({
          component: "provider",
        }),
      }),
    },

    PaymentOperationsUseCase,
    PaymentHistoryUseCase,

    // Фоновые процессы: отправка событий и сверка незавершённых операций.
    PaymentOutboxPublisher,
    PaymentReconciler,
  ],
})
export class AppModule {}
