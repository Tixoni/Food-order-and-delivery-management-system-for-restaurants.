import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ServiceKitModule } from "@food-delivery/service-kit";
import { loadConfig } from "./config/configuration";
import { RestaurantOrmEntity } from "./infrastructure/persistence/restaurant.orm-entity";
import { TypeOrmRestaurantRepository } from "./infrastructure/persistence/typeorm-restaurant.repository";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { RESTAURANT_REPOSITORY } from "./application/ports/restaurant.repository";
import { ListRestaurantsUseCase } from "./application/use-cases/list-restaurants.use-case";
import { RestaurantsController } from "./interface/http/restaurants.controller";

const config = loadConfig();

@Module({
  imports: [
    // Проверки, метрики и сквозной идентификатор — из общего каркаса
    ServiceKitModule.forRoot({
      serviceName: "catalog",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      entities: [RestaurantOrmEntity],
      // Схема создаётся миграциями, а не автоматически: изменение структуры
      // базы должно быть осознанным и воспроизводимым.
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
    TypeOrmModule.forFeature([RestaurantOrmEntity]),
  ],
  controllers: [RestaurantsController],
  providers: [
    ListRestaurantsUseCase,
    {
      // Здесь абстракция встречается с реализацией. Единственное место,
      // где сервис узнаёт, что хранилище — это PostgreSQL.
      provide: RESTAURANT_REPOSITORY,
      useClass: TypeOrmRestaurantRepository,
    },
  ],
})
export class AppModule {}
