import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AuthModule,
  INTERNAL_TOKEN,
  InternalTokenGuard,
  ServiceKitModule,
} from "@food-delivery/service-kit";
import { DELIVERY_CONFIG, loadConfig } from "./config/configuration";
import { DISPATCH_SETTINGS } from "./application/dispatch-settings";
import { DELIVERY_REPOSITORY } from "./application/ports/delivery.repository";
import { LOCATION_HISTORY, POSITION_CACHE } from "./application/ports/positions";
import { CourierUseCase } from "./application/use-cases/courier.use-case";
import { DispatchUseCase } from "./application/use-cases/dispatch.use-case";
import { TrackingUseCase } from "./application/use-cases/tracking.use-case";
import {
  DeliveryOutboxPublisher,
  OfferTimeoutScheduler,
} from "./infrastructure/background/delivery-background";
import { BatchedLocationHistory } from "./infrastructure/locations/batched-location-history";
import { RedisPositions } from "./infrastructure/locations/redis-positions";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { SqlDeliveryRepository } from "./infrastructure/persistence/sql-delivery.repository";
import {
  AdminCouriersController,
  CourierController,
  InternalDeliveryController,
  TrackingController,
} from "./interface/http/delivery.controllers";

const config = loadConfig();

/**
 * Сервис доставки: курьеры, смены, геопозиция, подбор и назначение.
 *
 * Слои: domain — курьер, доставка, предложение; application — сценарии
 * и порты; infrastructure — PostGIS, Redis, брокер, фоновые процессы;
 * interface — внутренний API для `order`, API курьера, клиента и администратора.
 */
@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "delivery",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    // Курьер, клиент и администратор — по токену пользователя (SEC-2, SEC-7);
    // внутренний API — по служебному токену.
    AuthModule.forRoot(config.auth),
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      // Запросы написаны на SQL (sql-delivery.repository.ts).
      entities: [],
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
  ],
  controllers: [
    InternalDeliveryController,
    CourierController,
    TrackingController,
    AdminCouriersController,
  ],
  providers: [
    { provide: DELIVERY_CONFIG, useValue: config },
    { provide: DISPATCH_SETTINGS, useValue: config.dispatch },
    { provide: INTERNAL_TOKEN, useValue: config.internalToken },
    InternalTokenGuard,

    { provide: DELIVERY_REPOSITORY, useClass: SqlDeliveryRepository },
    RedisPositions,
    { provide: POSITION_CACHE, useExisting: RedisPositions },
    BatchedLocationHistory,
    { provide: LOCATION_HISTORY, useExisting: BatchedLocationHistory },

    DispatchUseCase,
    CourierUseCase,
    TrackingUseCase,

    // Фоновые процессы: события в брокер и таймер предложений.
    DeliveryOutboxPublisher,
    OfferTimeoutScheduler,
  ],
})
export class AppModule {}
