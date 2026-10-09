import { DomainRuleError } from "@food-delivery/shared";
import { Coordinates } from "../../domain/coordinates";
import { DeliveryZone } from "../../domain/delivery-zone";
import type { RestaurantScheduleRepository } from "../ports/restaurant-schedule.repository";
import {
  InMemoryDeliveryZoneRepository,
  InMemoryMenuRepository,
  InMemoryRestaurantRepository,
  category,
  item,
  restaurant,
} from "./in-memory.doubles";
import { ValidateCartUseCase } from "./validate-cart.use-case";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const point = (latitude: number, longitude: number) => Coordinates.create({ latitude, longitude });
const monday = new Date("2026-09-21T12:00:00Z");

describe("проверка корзины перед оформлением", () => {
  const build = () => {
    const restaurants = new InMemoryRestaurantRepository([restaurant()]);
    const zones = new InMemoryDeliveryZoneRepository(
      [
        DeliveryZone.create({
          id: "z-1",
          restaurantId: "r-1",
          name: "Центр",
          ring: [point(55.7, 37.5), point(55.7, 37.7), point(55.8, 37.7), point(55.8, 37.5)],
          deliveryFee: 15000,
          minOrderAmount: 50000,
          isActive: true,
        }),
      ],
      restaurants,
    );
    const menu = new InMemoryMenuRepository(
      [category("c-1", "Еда")],
      [item(ITEM_ID, "c-1", "Пицца", { price: 30000 })],
    );
    const schedules: RestaurantScheduleRepository = {
      findByRestaurant: async () => [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "21:00" }],
      replace: async () => undefined,
    };
    return { menu, zones, useCase: new ValidateCartUseCase(restaurants, schedules, zones, menu) };
  };

  const request = {
    restaurantId: "r-1",
    latitude: 55.75,
    longitude: 37.62,
    items: [{ itemId: ITEM_ID, quantity: 2 }],
  };

  it("считает цену, минимум зоны и доставку на сервере", async () => {
    const result = await build().useCase.execute(request, monday);
    expect(result).toMatchObject({
      zoneId: "z-1",
      itemsAmount: 60000,
      deliveryFee: 15000,
      total: 75000,
    });
    expect(result).toHaveProperty("pickup");
  });

  it("не допускает оформление вне часов работы", async () => {
    await expect(
      build().useCase.execute(request, new Date("2026-09-21T20:00:00Z")),
    ).rejects.toThrow(/сейчас не принимает/);
  });

  it("не принимает адрес вне зоны и сумму ниже минимума", async () => {
    const { useCase } = build();
    await expect(useCase.execute({ ...request, longitude: 38 }, monday)).rejects.toThrow(
      /не доставляет/,
    );
    await expect(
      useCase.execute({ ...request, items: [{ itemId: ITEM_ID, quantity: 1 }] }, monday),
    ).rejects.toThrow(/минимальная сумма/);
  });

  it("не принимает блюдо из стоп-листа", async () => {
    const { useCase, menu } = build();
    await menu.saveItem(menu.items[0].withAvailability(false));
    await expect(useCase.execute(request, monday)).rejects.toThrow(DomainRuleError);
  });
});
