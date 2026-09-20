import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { loadConfig } from "./config/configuration";
import { RestaurantOrmEntity } from "./infrastructure/persistence/restaurant.orm-entity";
import { TypeOrmRestaurantRepository } from "./infrastructure/persistence/typeorm-restaurant.repository";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { RESTAURANT_REPOSITORY } from "./application/ports/restaurant.repository";
import { ListRestaurantsUseCase } from "./application/use-cases/list-restaurants.use-case";
import { HealthController } from "./interface/http/health.controller";
import { MetricsController } from "./interface/http/metrics.controller";
import { RestaurantsController } from "./interface/http/restaurants.controller";
import { CorrelationMiddleware } from "./interface/http/correlation.middleware";

const config = loadConfig();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      ...config.database,
      entities: [RestaurantOrmEntity],
      // Схема создаётся миграциями, а не автоматически: изменение структуры
      // базы должно быть осознанным и воспроизводимым (шаг 0.6).
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
    TypeOrmModule.forFeature([RestaurantOrmEntity]),
  ],
  controllers: [HealthController, MetricsController, RestaurantsController],
  providers: [
    MetricsService,
    ListRestaurantsUseCase,
    {
      // Здесь абстракция встречается с реализацией. Единственное место,
      // где сервис узнаёт, что хранилище — это PostgreSQL.
      provide: RESTAURANT_REPOSITORY,
      useClass: TypeOrmRestaurantRepository,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
