import { randomUUID } from "node:crypto";
import { DELIVERY_EVENT_TYPES } from "@food-delivery/contracts";
import {
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  NotFoundError,
} from "@food-delivery/shared";
import type { CourierState } from "../../domain/courier";
import { distanceMeters } from "../../domain/geo";
import { Routing } from "../routing";
import { CourierUseCase } from "./courier.use-case";
import { DispatchUseCase } from "./dispatch.use-case";
import {
  FakeRoutePlanner,
  InMemoryDeliveryRepository,
  InMemoryPositions,
} from "./in-memory.doubles";
import { TrackingUseCase } from "./tracking.use-case";

const RESTAURANT = { latitude: 55.75, longitude: 37.6 };
const CLIENT = { latitude: 55.76, longitude: 37.62 };
const SETTINGS = { radiusMeters: 3000, offerTtlSeconds: 90, freshSeconds: 120 };

/** Точка в `meters` к северу от ресторана. */
const north = (meters: number) => ({
  latitude: RESTAURANT.latitude + meters / 111_195,
  longitude: RESTAURANT.longitude,
});

function setup() {
  const repo = new InMemoryDeliveryRepository();
  const positions = new InMemoryPositions();
  const routes = new FakeRoutePlanner();
  const routing = new Routing(routes, repo);
  const dispatch = new DispatchUseCase(repo, SETTINGS, routing);
  const couriers = new CourierUseCase(repo, positions, positions, dispatch, routing);
  const tracking = new TrackingUseCase(repo, positions, routing);

  const addCourier = (
    name: string,
    at: { latitude: number; longitude: number },
    overrides: Partial<CourierState> = {},
  ) => {
    const state: CourierState = {
      id: randomUUID(),
      userId: randomUUID(),
      fullName: name,
      phone: null,
      vehicleType: "bike",
      status: "available",
      currentDeliveryId: null,
      isActive: true,
      lastLocation: at,
      lastLocationAt: new Date(),
      ...overrides,
    };
    repo.addCourier(state);
    return { id: state.id, userId: state.userId!, at };
  };

  const orderId = randomUUID();
  const customerId = randomUUID();
  const request = (key = `${orderId}:courier:1`) =>
    dispatch.requestCourier({
      orderId,
      restaurantId: randomUUID(),
      customerId,
      idempotencyKey: key,
      pickup: RESTAURANT,
      dropoff: CLIENT,
      readyAt: new Date().toISOString(),
      orderNumber: 1042,
      dropoffAddress: "Тверская, 7, кв. 12",
      contactPhone: "+7 900 123-45-67",
    });
  const openOffer = (courierId: string) =>
    [...repo.offers.values()].find((o) => o.courierId === courierId && !o.response);

  return {
    repo,
    positions,
    routes,
    dispatch,
    couriers,
    tracking,
    addCourier,
    orderId,
    customerId,
    request,
    openOffer,
  };
}

describe("подбор курьера (DLV-3)", () => {
  it("предлагает заказ ближайшему свободному в радиусе 3 км", async () => {
    const w = setup();
    const far = w.addCourier("далёкий", north(2500));
    const near = w.addCourier("ближний", north(400));
    w.addCourier("за радиусом", north(3500));
    w.addCourier("занят", north(100), { status: "busy" });
    w.addCourier("без связи", north(50), { lastLocationAt: new Date(Date.now() - 10 * 60_000) });

    const result = await w.request();

    expect(result.status).toBe("PENDING");
    expect(w.openOffer(near.id)).toBeDefined();
    expect(w.openOffer(far.id)).toBeUndefined();
    expect(w.repo.couriers.get(near.id)?.status).toBe("assigned");
    expect(w.repo.eventsOfType(DELIVERY_EVENT_TYPES.courierAssigned)).toHaveLength(1);
  });

  it("повтор запроса с тем же ключом не создаёт вторую доставку и второе предложение", async () => {
    const w = setup();
    w.addCourier("ближний", north(400));
    const first = await w.request();
    const second = await w.request();

    expect(second.deliveryId).toBe(first.deliveryId);
    expect(w.repo.deliveries.size).toBe(1);
    expect(w.repo.offers.size).toBe(1);
  });

  it("пропустивший предложение курьер получит заказ снова в новом раунде поиска", async () => {
    const w = setup();
    const only = w.addCourier("единственный", north(200));
    await w.request();
    await w.dispatch.expireOffers(new Date(Date.now() + 91_000));
    // В этом раунде предлагать больше некому
    expect(w.repo.eventsOfType(DELIVERY_EVENT_TYPES.courierNotFound)).toHaveLength(1);
    expect(w.openOffer(only.id)).toBeUndefined();

    // order повторяет запрос — новый раунд: тот же курьер снова в кандидатах
    await new Promise((resolve) => setTimeout(resolve, 5));
    await w.request(`${w.orderId}:courier:2`);
    expect(w.openOffer(only.id)?.sequence).toBe(2);
  });

  it("кандидатов нет — одно событие CourierNotFound; новый запрос от order ищет заново", async () => {
    const w = setup();
    await w.request();
    await w.dispatch.offerNext([...w.repo.deliveries.keys()][0]);
    expect(w.repo.eventsOfType(DELIVERY_EVENT_TYPES.courierNotFound)).toHaveLength(1);

    const fresh = w.addCourier("вышел на смену", north(300));
    await w.request(`${w.orderId}:courier:2`);
    expect(w.openOffer(fresh.id)).toBeDefined();
  });
});

describe("назначение и переназначение (DLV-4)", () => {
  it("молчание 90 с — предложение следующему, цепочка попыток видна", async () => {
    const w = setup();
    const first = w.addCourier("первый", north(200));
    const second = w.addCourier("второй", north(800));
    await w.request();

    const expired = await w.dispatch.expireOffers(new Date(Date.now() + 91_000));

    expect(expired).toBe(1);
    expect(w.repo.couriers.get(first.id)?.status).toBe("available");
    const offer = w.openOffer(second.id);
    expect(offer?.sequence).toBe(2);
    const chain = [...w.repo.offers.values()].map((o) => `${o.sequence}:${o.response ?? "open"}`);
    expect(chain.sort()).toEqual(["1:TIMEOUT", "2:open"]);
  });

  it("отказ — сразу следующему; отказавшемуся второй раз не предлагают", async () => {
    const w = setup();
    const first = w.addCourier("первый", north(200));
    const second = w.addCourier("второй", north(800));
    await w.request();

    await w.couriers.reject({ userId: first.userId }, w.openOffer(first.id)!.id);

    expect(w.openOffer(second.id)).toBeDefined();
    await w.couriers.reject({ userId: second.userId }, w.openOffer(second.id)!.id);
    expect(w.repo.eventsOfType(DELIVERY_EVENT_TYPES.courierNotFound)).toHaveLength(1);
  });

  it("принять просроченное нельзя — заказ уже у следующего курьера", async () => {
    const w = setup();
    const first = w.addCourier("первый", north(200));
    await w.request();
    const offerId = w.openOffer(first.id)!.id;

    await expect(
      w.couriers.accept({ userId: first.userId }, offerId, new Date(Date.now() + 95_000)),
    ).rejects.toThrow(ConflictError);
  });

  it("чужое предложение не принять", async () => {
    const w = setup();
    const first = w.addCourier("первый", north(200));
    const stranger = w.addCourier("чужой", north(5000));
    await w.request();

    await expect(
      w.couriers.accept({ userId: stranger.userId }, w.openOffer(first.id)!.id),
    ).rejects.toThrow("другому курьеру");
  });
});

describe("доставка (DLV-5) и события для order", () => {
  it("принял → забрал → вручил; курьер снова свободен", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    const { deliveryId } = await w.request();
    const me = { userId: courier.userId };

    await w.couriers.accept(me, w.openOffer(courier.id)!.id);
    await expect(w.couriers.delivered(me, deliveryId)).rejects.toThrow(DomainRuleError);
    await w.couriers.pickedUp(me, deliveryId);
    await w.couriers.delivered(me, deliveryId);

    expect(w.repo.couriers.get(courier.id)).toMatchObject({
      status: "available",
      currentDeliveryId: null,
    });
    const types = w.repo.outbox.map((entry) => entry.event.eventType);
    expect(types).toEqual([
      DELIVERY_EVENT_TYPES.courierAssigned,
      DELIVERY_EVENT_TYPES.courierAccepted,
      DELIVERY_EVENT_TYPES.orderPickedUp,
      DELIVERY_EVENT_TYPES.deliveryCompleted,
    ]);
    expect(w.repo.outbox.every((entry) => entry.orderId === w.orderId)).toBe(true);
    expect(
      (w.repo.eventsOfType(DELIVERY_EVENT_TYPES.orderPickedUp)[0].payload as { etaMinutes: number })
        .etaMinutes,
    ).toBeGreaterThan(0);
  });

  it("отмена заказа освобождает курьера и закрывает открытое предложение", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();

    await expect(
      w.dispatch.releaseCourier({ orderId: w.orderId, idempotencyKey: "r-1" }),
    ).resolves.toEqual({ released: true });
    expect(w.repo.couriers.get(courier.id)?.status).toBe("available");
    expect([...w.repo.offers.values()][0].response).toBe("CANCELLED");
    await expect(
      w.dispatch.releaseCourier({ orderId: w.orderId, idempotencyKey: "r-2" }),
    ).resolves.toEqual({ released: false });
  });
});

describe("смена и геопозиция (DLV-1, DLV-2, TRK-2)", () => {
  it("точность и скорость вне диапазона истории — «не измерено», запись пачки не срывается", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200), { status: "offline" });
    const me = { userId: courier.userId };
    await w.couriers.setShift(me, true);

    await w.couriers.updateLocation(me, { ...north(150), accuracy: 15_000, speed: -3 });
    await w.couriers.updateLocation(me, { ...north(140), accuracy: 25.5, speed: 4 });

    expect(w.positions.history.map(({ position }) => [position.accuracy, position.speed])).toEqual([
      [null, null],
      [25.5, 4],
    ]);
  });

  it("позиция принимается только на смене; на доставке рассылается клиенту заказа", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200), { status: "offline" });
    const me = { userId: courier.userId };

    await expect(w.couriers.updateLocation(me, north(150))).rejects.toThrow(ForbiddenError);
    await w.couriers.setShift(me, true);
    await w.couriers.updateLocation(me, north(150));
    expect(w.positions.history).toHaveLength(1);
    expect(w.positions.published).toHaveLength(0);

    w.repo.freshUntil.set(courier.id, new Date());
    const { deliveryId } = await w.request();
    await w.couriers.accept(me, w.openOffer(courier.id)!.id);
    await w.couriers.updateLocation(me, north(100));

    expect(w.positions.published).toEqual([expect.objectContaining({ orderId: w.orderId })]);
    expect(deliveryId).toBeDefined();
  });

  it("с заказом на руках со смены не уйти", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();
    await w.couriers.accept({ userId: courier.userId }, w.openOffer(courier.id)!.id);

    await expect(w.couriers.setShift({ userId: courier.userId }, false)).rejects.toThrow(
      DomainRuleError,
    );
  });

  it("учётная запись без курьера — отказ", async () => {
    const w = setup();
    await expect(w.couriers.dashboard({ userId: randomUUID() })).rejects.toThrow(ForbiddenError);
  });
});

describe("экран курьера", () => {
  it("адрес и номер — сразу, телефон клиента — только после принятия (SEC-4)", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();
    const me = { userId: courier.userId };

    const offered = await w.couriers.dashboard(me);
    expect(offered.offer?.delivery).toMatchObject({
      orderNumber: 1042,
      dropoffAddress: "Тверская, 7, кв. 12",
      contactPhone: null,
    });

    await w.couriers.accept(me, offered.offer!.id);
    const working = await w.couriers.dashboard(me);
    expect(working.offer).toBeNull();
    expect(working.delivery?.contactPhone).toBe("+7 900 123-45-67");
  });
});

describe("позиция курьера для клиента (SEC-7)", () => {
  it("видит клиент заказа и оператор; чужой клиент — «не найдено»", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();
    await w.couriers.accept({ userId: courier.userId }, w.openOffer(courier.id)!.id);
    await w.couriers.updateLocation({ userId: courier.userId }, north(120));

    const own = await w.tracking.courierPosition(w.orderId, {
      userId: w.customerId,
      roles: ["client"],
    });
    expect(own.position).toMatchObject({ latitude: north(120).latitude });

    await expect(
      w.tracking.courierPosition(w.orderId, { userId: randomUUID(), roles: ["client"] }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      w.tracking.courierPosition(w.orderId, { userId: randomUUID(), roles: ["operator"] }),
    ).resolves.toMatchObject({ status: "ASSIGNED" });
  });
});

describe("маршрут и время в пути (DLV-3, DLV-6)", () => {
  /** Точка в `meters` к востоку от ресторана. */
  const east = (meters: number) => ({
    latitude: RESTAURANT.latitude,
    longitude:
      RESTAURANT.longitude + meters / (111_195 * Math.cos((RESTAURANT.latitude * Math.PI) / 180)),
  });

  it("предложение — тому, кто раньше доедет по дорогам, а не ближнему по прямой", async () => {
    const w = setup();
    const acrossRiver = w.addCourier("за рекой", north(400));
    const onRoad = w.addCourier("по дороге", east(1500));
    // До моста — крюк в пять километров
    w.routes.road = (from, to) =>
      from.latitude === acrossRiver.at.latitude ? 5000 : distanceMeters(from, to) * 1.3;

    await w.request();

    expect(w.openOffer(onRoad.id)).toBeDefined();
    expect(w.openOffer(acrossRiver.id)).toBeUndefined();
  });

  it("учитывается транспорт: велосипедист в 1,5 км успеет раньше пешего в 600 м", async () => {
    const w = setup();
    const walker = w.addCourier("пеший", north(600), { vehicleType: "foot" });
    const cyclist = w.addCourier("велосипедист", east(1500), { vehicleType: "bike" });

    await w.request();

    // Пеший: 840 м / 5 км/ч ≈ 10 мин; велосипед: 2100 м / 14 км/ч = 9 мин
    expect(w.openOffer(cyclist.id)).toBeDefined();
    expect(w.openOffer(walker.id)).toBeUndefined();
  });

  it("маршрутизатор недоступен — предложение ближнему по прямой (REL-2)", async () => {
    const w = setup();
    w.routes.down = true;
    const near = w.addCourier("ближний", north(400), { vehicleType: "foot" });
    w.addCourier("велосипедист", east(1500), { vehicleType: "bike" });

    const result = await w.request();

    expect(result.status).toBe("PENDING");
    expect(w.openOffer(near.id)).toBeDefined();
  });

  it("маршрут считается один раз; его видят курьер в предложении и клиент", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();
    const me = { userId: courier.userId };
    const callsBefore = w.routes.calls;

    const first = await w.couriers.dashboard(me);
    await w.couriers.dashboard(me);
    const tracked = await w.tracking.courierPosition(w.orderId, {
      userId: w.customerId,
      roles: ["client"],
    });

    expect(first.offer?.delivery.route?.distanceMeters).toBeGreaterThan(0);
    expect(tracked.route?.path).toHaveLength(2);
    expect(w.routes.calls - callsBefore).toBe(1);
  });

  it("маршрутизатор лежал — экраны без маршрута; поднялся — маршрут появляется", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200));
    await w.request();
    const me = { userId: courier.userId };

    w.routes.down = true;
    expect((await w.couriers.dashboard(me)).offer?.delivery.route).toBeNull();

    w.routes.down = false;
    expect((await w.couriers.dashboard(me)).offer?.delivery.route).not.toBeNull();
  });

  it("прогноз в событии «забрал» — по длине маршрута, а не по прямой", async () => {
    const w = setup();
    const courier = w.addCourier("курьер", north(200), { vehicleType: "bike" });
    // Ресторан → клиент: 7 км по дорогам при 1,7 км по прямой
    w.routes.road = (from, to) =>
      to.latitude === CLIENT.latitude ? 7000 : distanceMeters(from, to) * 1.4;
    const { deliveryId } = await w.request();
    const me = { userId: courier.userId };

    await w.couriers.accept(me, w.openOffer(courier.id)!.id);
    await w.couriers.dashboard(me);
    await w.couriers.pickedUp(me, deliveryId);

    const [event] = w.repo.eventsOfType(DELIVERY_EVENT_TYPES.orderPickedUp);
    // 7 км / 14 км/ч = 30 мин; по прямой вышло бы 11
    expect((event.payload as { etaMinutes: number }).etaMinutes).toBe(30);
  });
});
