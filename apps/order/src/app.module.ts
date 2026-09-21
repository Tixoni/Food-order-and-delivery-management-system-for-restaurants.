import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ServiceKitModule } from "@food-delivery/service-kit";
import { loadConfig } from "./config/configuration";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";

const config = loadConfig();

/**
 * Создано по образцу сервиса catalog. Слои появятся по мере наполнения сервиса:
 * domain — правила предметной области, application — сценарии и порты,
 * infrastructure — реализации портов, interface — приём запросов.
 */
@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "order",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      entities: [],
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
