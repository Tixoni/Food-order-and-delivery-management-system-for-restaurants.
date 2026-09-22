import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ServiceKitModule } from "@food-delivery/service-kit";
import { loadConfig } from "./config/configuration";
import { RestaurantOrmEntity } from "./infrastructure/persistence/restaurant.orm-entity";
import {
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
} from "./infrastructure/persistence/menu.orm-entities";
import { TypeOrmRestaurantRepository } from "./infrastructure/persistence/typeorm-restaurant.repository";
import { TypeOrmMenuRepository } from "./infrastructure/persistence/typeorm-menu.repository";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { RESTAURANT_REPOSITORY } from "./application/ports/restaurant.repository";
import { MENU_REPOSITORY } from "./application/ports/menu.repository";
import { ListRestaurantsUseCase } from "./application/use-cases/list-restaurants.use-case";
import { GetRestaurantMenuUseCase } from "./application/use-cases/get-restaurant-menu.use-case";
import { ManageMenuItemUseCase } from "./application/use-cases/manage-menu-item.use-case";
import { PriceMenuItemUseCase } from "./application/use-cases/price-menu-item.use-case";
import { RestaurantsController } from "./interface/http/restaurants.controller";
import { MenuController } from "./interface/http/menu.controller";

const config = loadConfig();

const ORM_ENTITIES = [
  RestaurantOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
];

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
      entities: ORM_ENTITIES,
      // Схема создаётся миграциями, а не автоматически: изменение структуры
      // базы должно быть осознанным и воспроизводимым.
      synchronize: false,
      migrationsRun: false,
      logging: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    }),
    TypeOrmModule.forFeature(ORM_ENTITIES),
  ],
  controllers: [RestaurantsController, MenuController],
  providers: [
    ListRestaurantsUseCase,
    GetRestaurantMenuUseCase,
    ManageMenuItemUseCase,
    PriceMenuItemUseCase,
    {
      // Здесь абстракция встречается с реализацией. Единственное место,
      // где сервис узнаёт, что хранилище — это PostgreSQL.
      provide: RESTAURANT_REPOSITORY,
      useClass: TypeOrmRestaurantRepository,
    },
    {
      provide: MENU_REPOSITORY,
      useClass: TypeOrmMenuRepository,
    },
  ],
})
export class AppModule {}
