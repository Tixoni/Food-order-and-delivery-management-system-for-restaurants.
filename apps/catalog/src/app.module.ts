import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule, ServiceKitModule } from "@food-delivery/service-kit";
import { CATALOG_CONFIG, loadConfig } from "./config/configuration";
import { RestaurantOrmEntity } from "./infrastructure/persistence/restaurant.orm-entity";
import { RestaurantScheduleOrmEntity } from "./infrastructure/persistence/restaurant-schedule.orm-entity";
import { TypeOrmRestaurantScheduleRepository } from "./infrastructure/persistence/typeorm-restaurant-schedule.repository";
import { RESTAURANT_SCHEDULE_REPOSITORY } from "./application/ports/restaurant-schedule.repository";
import { ManageRestaurantScheduleUseCase } from "./application/use-cases/manage-restaurant-schedule.use-case";
import { ValidateCartUseCase } from "./application/use-cases/validate-cart.use-case";
import {
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
} from "./infrastructure/persistence/menu.orm-entities";
import { DeliveryZoneOrmEntity } from "./infrastructure/persistence/delivery-zone.orm-entity";
import { OutboxMessageOrmEntity } from "./infrastructure/persistence/outbox.orm-entity";
import { StopListEntryOrmEntity } from "./infrastructure/persistence/stop-list.orm-entity";
import { TypeOrmRestaurantRepository } from "./infrastructure/persistence/typeorm-restaurant.repository";
import { TypeOrmMenuRepository } from "./infrastructure/persistence/typeorm-menu.repository";
import { TypeOrmMenuStructureRepository } from "./infrastructure/persistence/typeorm-menu-structure.repository";
import { TypeOrmMenuSearchRepository } from "./infrastructure/persistence/typeorm-menu-search.repository";
import { TypeOrmStopListRepository } from "./infrastructure/persistence/typeorm-stop-list.repository";
import { TypeOrmDeliveryZoneRepository } from "./infrastructure/persistence/typeorm-delivery-zone.repository";
import { DatabaseReadinessCheck } from "./infrastructure/persistence/database-readiness.check";
import { OutboxPublisher } from "./infrastructure/messaging/outbox.publisher";
import { RedisMenuCache } from "./infrastructure/cache/redis-menu.cache";
import { RESTAURANT_REPOSITORY } from "./application/ports/restaurant.repository";
import { MENU_REPOSITORY } from "./application/ports/menu.repository";
import { MENU_STRUCTURE_REPOSITORY } from "./application/ports/menu-structure.repository";
import { MENU_SEARCH_REPOSITORY } from "./application/ports/menu-search.repository";
import { STOP_LIST_REPOSITORY } from "./application/ports/stop-list.repository";
import { MENU_CACHE } from "./application/ports/menu-cache";
import { DELIVERY_ZONE_REPOSITORY } from "./application/ports/delivery-zone.repository";
import { ListRestaurantsUseCase } from "./application/use-cases/list-restaurants.use-case";
import { FindRestaurantsForAddressUseCase } from "./application/use-cases/find-restaurants-for-address.use-case";
import { GetRestaurantMenuUseCase } from "./application/use-cases/get-restaurant-menu.use-case";
import { GetStopListHistoryUseCase } from "./application/use-cases/get-stop-list-history.use-case";
import { ManageDeliveryZoneUseCase } from "./application/use-cases/manage-delivery-zone.use-case";
import { ManageMenuItemUseCase } from "./application/use-cases/manage-menu-item.use-case";
import { ManageMenuStructureUseCase } from "./application/use-cases/manage-menu-structure.use-case";
import { ManageRestaurantUseCase } from "./application/use-cases/manage-restaurant.use-case";
import { PriceMenuItemUseCase } from "./application/use-cases/price-menu-item.use-case";
import { SetMenuItemAvailabilityUseCase } from "./application/use-cases/set-menu-item-availability.use-case";
import { SearchMenuUseCase } from "./application/use-cases/search-menu.use-case";
import { RestaurantsController } from "./interface/http/restaurants.controller";
import { MenuController } from "./interface/http/menu.controller";
import { DeliveryZonesController } from "./interface/http/delivery-zones.controller";

const config = loadConfig();

const ORM_ENTITIES = [
  RestaurantOrmEntity,
  RestaurantScheduleOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  StopListEntryOrmEntity,
  DeliveryZoneOrmEntity,
  OutboxMessageOrmEntity,
];

@Module({
  imports: [
    // Проверки, метрики и сквозной идентификатор — из общего каркаса
    ServiceKitModule.forRoot({
      serviceName: "catalog",
      readinessChecks: [DatabaseReadinessCheck],
      readinessTokens: [DatabaseReadinessCheck],
    }),
    // Проверка входа и ролей на каждом запросе (SEC-2). Обработчики
    // закрыты по умолчанию и открываются пометкой Public.
    AuthModule.forRoot(config.auth),
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
  controllers: [RestaurantsController, MenuController, DeliveryZonesController],
  providers: [
    { provide: CATALOG_CONFIG, useValue: config },
    ListRestaurantsUseCase,
    FindRestaurantsForAddressUseCase,
    GetRestaurantMenuUseCase,
    GetStopListHistoryUseCase,
    ManageDeliveryZoneUseCase,
    ManageMenuItemUseCase,
    ManageMenuStructureUseCase,
    ManageRestaurantUseCase,
    ManageRestaurantScheduleUseCase,
    ValidateCartUseCase,
    PriceMenuItemUseCase,
    SetMenuItemAvailabilityUseCase,
    SearchMenuUseCase,
    // Отправка накопленных событий в брокер. Отдельный фоновый процесс:
    // запрос пользователя не ждёт брокера (REL-3).
    OutboxPublisher,
    {
      // Здесь абстракция встречается с реализацией. Единственное место,
      // где сервис узнаёт, что хранилище — это PostgreSQL, а кэш — Redis.
      provide: RESTAURANT_REPOSITORY,
      useClass: TypeOrmRestaurantRepository,
    },
    { provide: RESTAURANT_SCHEDULE_REPOSITORY, useClass: TypeOrmRestaurantScheduleRepository },
    {
      provide: MENU_REPOSITORY,
      useClass: TypeOrmMenuRepository,
    },
    {
      provide: MENU_STRUCTURE_REPOSITORY,
      useClass: TypeOrmMenuStructureRepository,
    },
    {
      provide: MENU_SEARCH_REPOSITORY,
      useClass: TypeOrmMenuSearchRepository,
    },
    {
      provide: STOP_LIST_REPOSITORY,
      useClass: TypeOrmStopListRepository,
    },
    {
      provide: DELIVERY_ZONE_REPOSITORY,
      useClass: TypeOrmDeliveryZoneRepository,
    },
    {
      provide: MENU_CACHE,
      useClass: RedisMenuCache,
    },
  ],
})
export class AppModule {}
