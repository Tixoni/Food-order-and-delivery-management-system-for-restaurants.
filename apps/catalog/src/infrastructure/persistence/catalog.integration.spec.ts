import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { createEvent } from "@food-delivery/shared";
import { Coordinates } from "../../domain/coordinates";
import { DeliveryZone } from "../../domain/delivery-zone";
import { MenuCategory } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { Restaurant } from "../../domain/restaurant";
import { ValidateCartUseCase } from "../../application/use-cases/validate-cart.use-case";
import { TypeOrmDeliveryZoneRepository } from "./typeorm-delivery-zone.repository";
import { TypeOrmMenuRepository } from "./typeorm-menu.repository";
import { TypeOrmMenuSearchRepository } from "./typeorm-menu-search.repository";
import { TypeOrmMenuStructureRepository } from "./typeorm-menu-structure.repository";
import { TypeOrmRestaurantRepository } from "./typeorm-restaurant.repository";
import { TypeOrmRestaurantScheduleRepository } from "./typeorm-restaurant-schedule.repository";
import { RestaurantOrmEntity } from "./restaurant.orm-entity";
import { RestaurantScheduleOrmEntity } from "./restaurant-schedule.orm-entity";
import { DeliveryZoneOrmEntity } from "./delivery-zone.orm-entity";
import {
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
} from "./menu.orm-entities";
import { OutboxMessageOrmEntity } from "./outbox.orm-entity";

const connectionUrl = process.env.CATALOG_INTEGRATION_DB_URL;
if (connectionUrl && !new URL(connectionUrl).pathname.endsWith("_verify_db")) {
  throw new Error("интеграционный тест допускается только на базе *_verify_db");
}
const run = connectionUrl ? describe : describe.skip;

/** Запуск: CATALOG_INTEGRATION_DB_URL=postgres://.../catalog_verify_db npm test -w @food-delivery/catalog */
run("репозитории каталога на PostgreSQL/PostGIS", () => {
  const restaurantId = randomUUID();
  const categoryId = randomUUID();
  const itemId = randomUUID();
  const zoneId = randomUUID();
  let db: DataSource;
  let restaurants: TypeOrmRestaurantRepository;
  let schedules: TypeOrmRestaurantScheduleRepository;
  let zones: TypeOrmDeliveryZoneRepository;
  let menu: TypeOrmMenuRepository;

  beforeAll(async () => {
    db = await new DataSource({
      type: "postgres",
      url: connectionUrl,
      synchronize: false,
      entities: [
        RestaurantOrmEntity,
        RestaurantScheduleOrmEntity,
        DeliveryZoneOrmEntity,
        MenuCategoryOrmEntity,
        MenuItemOrmEntity,
        ItemOptionGroupOrmEntity,
        ItemOptionOrmEntity,
        OutboxMessageOrmEntity,
      ],
    }).initialize();
    restaurants = new TypeOrmRestaurantRepository(db.getRepository(RestaurantOrmEntity), db);
    schedules = new TypeOrmRestaurantScheduleRepository(
      db.getRepository(RestaurantScheduleOrmEntity),
    );
    zones = new TypeOrmDeliveryZoneRepository(db);
    menu = new TypeOrmMenuRepository(
      db.getRepository(MenuCategoryOrmEntity),
      db.getRepository(MenuItemOrmEntity),
      db.getRepository(ItemOptionGroupOrmEntity),
      db.getRepository(ItemOptionOrmEntity),
      db,
    );

    await restaurants.save(
      Restaurant.create({
        id: restaurantId,
        name: "Тестовый ресторан",
        minOrderAmount: 50000,
        deliveryFeeBase: 10000,
        avgCookingTimeMin: 20,
        isActive: true,
        timeZone: "Europe/Moscow",
      }),
    );
    await menu.saveCategory(
      MenuCategory.create({
        id: categoryId,
        restaurantId,
        name: "Пицца",
        sortOrder: 0,
        isActive: true,
      }),
    );
    await schedules.replace(restaurantId, [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "21:00" }]);
    const point = (latitude: number, longitude: number) =>
      Coordinates.create({ latitude, longitude });
    await zones.save(
      DeliveryZone.create({
        id: zoneId,
        restaurantId,
        name: "Центр",
        ring: [point(55.7, 37.5), point(55.7, 37.7), point(55.8, 37.7), point(55.8, 37.5)],
        deliveryFee: 10000,
        minOrderAmount: 50000,
        isActive: true,
      }),
    );
  });

  afterAll(async () => {
    if (!db?.isInitialized) return;
    await db.query("DELETE FROM outbox_messages WHERE aggregate_id IN ($1, $2, $3, $4)", [
      itemId,
      categoryId,
      restaurantId,
      zoneId,
    ]);
    await db.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
    await db.destroy();
  });

  it("сохраняет изображение, ищет по составу и проверяет корзину с зоной и расписанием", async () => {
    const dish = MenuItem.create({
      id: itemId,
      restaurantId,
      categoryId,
      name: "Особая пицца",
      composition: "томаты, сыр",
      imageUrl: "https://example.org/pizza.jpg",
      price: 30000,
      isAvailable: true,
      sortOrder: 0,
    });
    await menu.saveItem(dish);
    expect((await menu.findItemById(itemId))?.imageUrl).toBe("https://example.org/pizza.jpg");
    const search = new TypeOrmMenuSearchRepository(db);
    expect((await search.search("томаты", restaurantId, 10)).map((hit) => hit.id)).toContain(
      itemId,
    );

    const quote = await new ValidateCartUseCase(restaurants, schedules, zones, menu).execute(
      {
        restaurantId,
        latitude: 55.75,
        longitude: 37.62,
        items: [{ itemId, quantity: 2 }],
      },
      new Date("2026-09-21T12:00:00Z"),
    );
    expect(quote).toMatchObject({ zoneId, itemsAmount: 60000, deliveryFee: 10000, total: 70000 });
  });

  it("атомарно заменяет модификаторы и сохраняет событие удаления блюда", async () => {
    const structure = new TypeOrmMenuStructureRepository(
      db.getRepository(MenuCategoryOrmEntity),
      db,
    );
    const group = (await import("../../domain/option-group")).OptionGroup.create({
      id: randomUUID(),
      name: "Размер",
      selectionType: "single",
      isRequired: true,
      minSelect: 1,
      maxSelect: 1,
      options: [
        (await import("../../domain/option-group")).ItemOption.create({
          id: randomUUID(),
          name: "Большой",
          priceDelta: 5000,
          isAvailable: true,
        }),
      ],
    });
    await structure.replaceGroups(itemId, [group], []);
    expect((await menu.findItemById(itemId))?.optionGroups[0].options[0].priceDelta).toBe(5000);

    const archived = (await menu.findItemById(itemId))!.archive();
    const event = {
      messageId: randomUUID(),
      eventType: "MenuUpdated",
      eventVersion: 1,
      aggregateType: "MenuItem",
      aggregateId: itemId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: { restaurantId, menuItemId: itemId, name: archived.name, change: "deleted" },
    };
    await menu.saveItem(archived, [event]);
    expect(await menu.findItemById(itemId)).toBeNull();
    const rows = await db.query("SELECT event_type FROM outbox_messages WHERE aggregate_id = $1", [
      itemId,
    ]);
    expect(rows).toEqual(expect.arrayContaining([{ event_type: "MenuUpdated" }]));
  });

  it("сохраняет события ресторана и зоны в outbox вместе с изменением", async () => {
    const restaurant = await restaurants.findById(restaurantId);
    const zone = await zones.findById(zoneId);
    expect(restaurant).not.toBeNull();
    expect(zone).not.toBeNull();
    const event = (eventType: string, aggregateType: string, aggregateId: string) =>
      createEvent({
        eventType,
        aggregateType,
        aggregateId,
        correlationId: randomUUID(),
        payload: { restaurantId },
      });

    await restaurants.save(restaurant!, [event("RestaurantChanged", "Restaurant", restaurantId)]);
    await zones.save(zone!, [event("DeliveryZoneChanged", "DeliveryZone", zoneId)]);

    const rows = await db.query(
      "SELECT event_type FROM outbox_messages WHERE aggregate_id IN ($1, $2)",
      [restaurantId, zoneId],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { event_type: "RestaurantChanged" },
        { event_type: "DeliveryZoneChanged" },
      ]),
    );
  });
});
