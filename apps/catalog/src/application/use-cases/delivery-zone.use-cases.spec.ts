import {
  ConflictError,
  DomainRuleError,
  NotFoundError,
  ValidationError,
} from "@food-delivery/shared";
import { Coordinates } from "../../domain/coordinates";
import { DeliveryZone } from "../../domain/delivery-zone";
import { FindRestaurantsForAddressUseCase } from "./find-restaurants-for-address.use-case";
import { ManageDeliveryZoneUseCase } from "./manage-delivery-zone.use-case";
import {
  InMemoryDeliveryZoneRepository,
  InMemoryRestaurantRepository,
  restaurant,
} from "./in-memory.doubles";

const at = (latitude: number, longitude: number) => Coordinates.create({ latitude, longitude });

/** Квадрат со стороной около 3 км вокруг заданной точки. */
const squareAround = (latitude: number, longitude: number, half = 0.015) => [
  at(latitude - half, longitude - half),
  at(latitude - half, longitude + half),
  at(latitude + half, longitude + half),
  at(latitude + half, longitude - half),
];

const zone = (
  id: string,
  restaurantId: string,
  centre: [number, number],
  overrides: Partial<Parameters<typeof DeliveryZone.create>[0]> = {},
) =>
  DeliveryZone.create({
    id,
    restaurantId,
    name: "Основная зона",
    ring: squareAround(centre[0], centre[1]),
    deliveryFee: 14900,
    minOrderAmount: 50000,
    isActive: true,
    ...overrides,
  });

const CENTRE: [number, number] = [55.75, 37.62];
const FAR_AWAY = at(59.93, 30.33);

describe("сценарий «рестораны по адресу»", () => {
  const build = () => {
    const restaurants = new InMemoryRestaurantRepository([
      restaurant("r-1"),
      restaurant("r-2"),
      restaurant("r-3"),
    ]);
    const zones = new InMemoryDeliveryZoneRepository(
      [
        zone("z-1", "r-1", CENTRE, { deliveryFee: 19900 }),
        zone("z-2", "r-2", CENTRE, { deliveryFee: 0, minOrderAmount: 90000 }),
        // Третий ресторан доставляет в другой район
        zone("z-3", "r-3", [55.9, 37.9]),
      ],
      restaurants,
    );

    return { zones, useCase: new FindRestaurantsForAddressUseCase(zones) };
  };

  it("находит рестораны, доставляющие по адресу", async () => {
    const offers = await build().useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1] });

    expect(offers.map((o) => o.restaurant.id)).toEqual(["r-2", "r-1"]);
  });

  it("отдаёт условия доставки той зоны, в которую попал адрес", async () => {
    const [first] = await build().useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1] });

    expect(first.deliveryFee).toBe(0);
    expect(first.minOrderAmount).toBe(90000);
    expect(first.zoneId).toBe("z-2");
  });

  it("сначала показывает тех, у кого доставка дешевле", async () => {
    const offers = await build().useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1] });

    expect(offers.map((o) => o.deliveryFee)).toEqual([0, 19900]);
  });

  it("по адресу вне всех зон возвращает пустой список, а не ошибку", async () => {
    const offers = await build().useCase.execute({
      latitude: FAR_AWAY.latitude,
      longitude: FAR_AWAY.longitude,
    });

    expect(offers).toEqual([]);
  });

  it("не показывает рестораны с отключённой зоной", async () => {
    const { zones, useCase } = build();
    await zones.save(zone("z-2", "r-2", CENTRE, { isActive: false }));

    const offers = await useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1] });

    expect(offers.map((o) => o.restaurant.id)).toEqual(["r-1"]);
  });

  it("неверные координаты — ошибка пользователя, а не сбой сервиса", async () => {
    await expect(
      build().useCase.execute({ latitude: 200, longitude: 37.6 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("ограничивает размер выдачи", async () => {
    const offers = await build().useCase.execute({
      latitude: CENTRE[0],
      longitude: CENTRE[1],
      limit: 1,
    });

    expect(offers).toHaveLength(1);
  });

  it("отвергает бессмысленный размер выдачи", async () => {
    await expect(
      build().useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1], limit: 0 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      build().useCase.execute({ latitude: CENTRE[0], longitude: CENTRE[1], limit: 5000 }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("сценарий «редактор зоны доставки»", () => {
  const build = () => {
    const restaurants = new InMemoryRestaurantRepository([restaurant("r-1"), restaurant("r-2")]);
    const zones = new InMemoryDeliveryZoneRepository([zone("z-1", "r-1", CENTRE)], restaurants);

    return { zones, useCase: new ManageDeliveryZoneUseCase(zones, restaurants) };
  };

  const ringPairs = squareAround(CENTRE[0], CENTRE[1]).map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
  }));

  it("создаёт зону по контуру с карты", async () => {
    const { zones, useCase } = build();

    const created = await useCase.create({ restaurantId: "r-1", ring: ringPairs });

    expect(created.ring).toHaveLength(5);
    expect(await zones.findById(created.id)).not.toBeNull();
    expect(zones.published).toMatchObject([
      {
        eventType: "DeliveryZoneChanged",
        payload: { restaurantId: "r-1", zoneId: created.id, change: "created" },
      },
    ]);
  });

  it("берёт условия ресторана, если менеджер их не задал", async () => {
    const created = await build().useCase.create({ restaurantId: "r-1", ring: ringPairs });

    expect(created.deliveryFee).toBe(14900);
    expect(created.minOrderAmount).toBe(50000);
  });

  it("не создаёт зону несуществующему ресторану", async () => {
    await expect(
      build().useCase.create({ restaurantId: "r-404", ring: ringPairs }),
    ).rejects.toThrow(NotFoundError);
  });

  it("переводит незамкнутый контур из двух точек в понятную ошибку", async () => {
    await expect(
      build().useCase.create({ restaurantId: "r-1", ring: ringPairs.slice(0, 2) }),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });

  it("сообщает о точке с неверными координатами", async () => {
    await expect(
      build().useCase.create({
        restaurantId: "r-1",
        ring: [...ringPairs, { latitude: 200, longitude: 37.6 }],
      }),
    ).rejects.toThrow(/широта вне допустимого диапазона/);
  });

  it("перерисовывает контур существующей зоны", async () => {
    const { useCase } = build();
    const moved = squareAround(55.8, 37.7).map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
    }));

    const updated = await useCase.update({ zoneId: "z-1", restaurantId: "r-1", ring: moved });

    expect(updated.ring[0].latitude).toBeCloseTo(55.785, 3);
  });

  it("меняет условия доставки, не трогая контур", async () => {
    const updated = await build().useCase.update({
      zoneId: "z-1",
      restaurantId: "r-1",
      deliveryFee: 0,
    });

    expect(updated.deliveryFee).toBe(0);
    expect(updated.ring).toHaveLength(5);
  });

  it("не даёт править зону чужого ресторана", async () => {
    await expect(
      build().useCase.update({ zoneId: "z-1", restaurantId: "r-2", deliveryFee: 0 }),
    ).rejects.toThrow(ConflictError);
  });

  it("сообщает, что зона не найдена", async () => {
    await expect(
      build().useCase.update({ zoneId: "z-404", restaurantId: "r-1", deliveryFee: 0 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("отключает зону, а не удаляет её", async () => {
    const { zones, useCase } = build();

    const disabled = await useCase.deactivate("z-1", "r-1");

    expect(disabled.isActive).toBe(false);
    expect(await zones.findById("z-1")).not.toBeNull();
    expect(zones.published).toMatchObject([
      {
        eventType: "DeliveryZoneChanged",
        payload: { restaurantId: "r-1", zoneId: "z-1", change: "updated" },
      },
    ]);
  });

  it("показывает менеджеру все зоны ресторана, включая отключённые", async () => {
    const { useCase } = build();
    await useCase.deactivate("z-1", "r-1");

    expect(await useCase.list("r-1")).toHaveLength(1);
  });

  it("не показывает зоны несуществующего ресторана", async () => {
    await expect(build().useCase.list("r-404")).rejects.toThrow(NotFoundError);
  });
});
