import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { DELIVERY_EVENT_TYPES } from "@food-delivery/contracts";
import { CourierUseCase } from "../../application/use-cases/courier.use-case";
import { DispatchUseCase } from "../../application/use-cases/dispatch.use-case";
import { InMemoryPositions } from "../../application/use-cases/in-memory.doubles";
import type { DeliveryConfig } from "../../config/configuration";
import { BatchedLocationHistory } from "../locations/batched-location-history";
import { SqlDeliveryRepository, SqlDeliveryTx } from "./sql-delivery.repository";
import { Delivery } from "../../domain/delivery";

const connectionUrl = process.env.DELIVERY_INTEGRATION_DB_URL;
if (connectionUrl && !new URL(connectionUrl).pathname.endsWith("_verify_db")) {
  throw new Error("интеграционный тест допускается только на базе *_verify_db");
}
const run = connectionUrl ? describe : describe.skip;

/**
 * Свойства, которые держит СУБД: пространственный индекс в подборе,
 * блокировка курьера при одновременном подборе, одна действующая доставка
 * на заказ, сроки предложений в базе, пакетная запись истории.
 *
 * Запуск: DELIVERY_INTEGRATION_DB_URL=postgres://.../delivery_verify_db \
 *         npm test -w @food-delivery/delivery -- delivery.integration
 */
run("доставка на PostgreSQL + PostGIS", () => {
  let db: DataSource;
  let repository: SqlDeliveryRepository;
  let dispatch: DispatchUseCase;
  let couriers: CourierUseCase;
  let history: BatchedLocationHistory;
  const positions = new InMemoryPositions();
  const settings = { radiusMeters: 3000, offerTtlSeconds: 90, freshSeconds: 120 };

  // Каждый прогон — в своём районе: точки прошлых прогонов не мешают подбору.
  const base = { latitude: 55.5 + Math.random() * 0.4, longitude: 37.3 + Math.random() * 0.6 };
  const north = (meters: number, from = base) => ({
    latitude: from.latitude + meters / 111_195,
    longitude: from.longitude,
  });

  async function addCourier(at: { latitude: number; longitude: number }, status = "available") {
    const userId = randomUUID();
    const [row] = await db.query(
      `INSERT INTO couriers (user_id, full_name, status, last_location, last_location_at)
       VALUES ($1, 'курьер проверки', $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, now())
       RETURNING id`,
      [userId, status, at.longitude, at.latitude],
    );
    return { id: row.id as string, userId };
  }

  const request = (orderId: string, pickup = base, key = `${orderId}:courier:1`) =>
    dispatch.requestCourier({
      orderId,
      restaurantId: randomUUID(),
      customerId: randomUUID(),
      idempotencyKey: key,
      pickup,
      dropoff: north(1500, pickup),
      readyAt: new Date().toISOString(),
    });

  const openOfferOf = async (courierId: string) =>
    (
      await db.query(
        `SELECT id, sequence FROM delivery_assignments WHERE courier_id = $1 AND response IS NULL`,
        [courierId],
      )
    )[0] as { id: string; sequence: number } | undefined;

  beforeAll(async () => {
    db = await new DataSource({ type: "postgres", url: connectionUrl, entities: [] }).initialize();
    // Курьеры прошлых прогонов не должны оказаться ближе нынешних.
    await db.query(`UPDATE couriers SET status = 'offline' WHERE status <> 'offline'`);
    await db.query(`UPDATE delivery_assignments SET response = 'CANCELLED', responded_at = now()
                     WHERE response IS NULL`);
    repository = new SqlDeliveryRepository(db);
    dispatch = new DispatchUseCase(repository, settings);
    history = new BatchedLocationHistory(db, {
      logLevel: "error",
      locations: { flushIntervalMs: 1000, maxBuffer: 1000, positionTtlSeconds: 60 },
    } as DeliveryConfig);
    couriers = new CourierUseCase(repository, positions, history, dispatch);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it("подбор идёт по пространственному индексу (DLV-3)", async () => {
    // Две тысячи курьеров по городу — на десятке планировщик выбрал бы перебор.
    await db.query(
      `INSERT INTO couriers (full_name, status, last_location, last_location_at)
       SELECT 'фон', 'offline',
              ST_SetSRID(ST_MakePoint(37.3 + random() * 0.6, 55.5 + random() * 0.4), 4326)::geography,
              now()
         FROM generate_series(1, 2000)`,
    );
    await db.query("ANALYZE couriers");
    const plan: Array<{ "QUERY PLAN": string }> = await db.query(
      `EXPLAIN SELECT id FROM couriers c
        WHERE c.status = 'available'
          AND ST_DWithin(c.last_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 3000)
        ORDER BY c.last_location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        LIMIT 1`,
      [base.longitude, base.latitude],
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/ix_couriers_(location|available)/);
  });

  it("подбор с блокировкой работает и при плане с сортировкой через GiST (KNN)", async () => {
    // Именно этот план ронял запрос с FOR UPDATE: «attempted to lock
    // invisible tuple». Принудительно включаем его и проверяем подбор.
    const spot = north(60_000);
    const courier = await addCourier(north(150, spot));
    const delivery = Delivery.open({
      id: randomUUID(),
      orderId: randomUUID(),
      restaurantId: null,
      customerId: null,
      pickup: spot,
      dropoff: north(1000, spot),
      readyAt: null,
      requestKey: "knn",
      correlationId: null,
      now: new Date(),
    });

    const candidate = await db.transaction(async (manager) => {
      await manager.query("SET LOCAL enable_bitmapscan = off");
      await manager.query("SET LOCAL enable_seqscan = off");
      await manager.query("SET LOCAL enable_sort = off");
      return new SqlDeliveryTx(manager).nearestCandidate(delivery, 3000, 120);
    });

    expect(candidate?.courier.id).toBe(courier.id);
    await db.query(`UPDATE couriers SET status = 'offline' WHERE id = $1`, [courier.id]);
  });

  it("предлагает ближайшему; дальше радиуса и без свежей позиции не предлагает", async () => {
    const near = await addCourier(north(300));
    const far = await addCourier(north(2000));
    await addCourier(north(3500));
    const stale = await addCourier(north(100));
    await db.query(
      `UPDATE couriers SET last_location_at = now() - interval '1 hour' WHERE id = $1`,
      [stale.id],
    );

    await request(randomUUID());

    expect(await openOfferOf(near.id)).toBeDefined();
    expect(await openOfferOf(far.id)).toBeUndefined();
    expect(await openOfferOf(stale.id)).toBeUndefined();
    // Освобождаем зону для следующих проверок
    await db.query(`UPDATE couriers SET status = 'offline' WHERE id = ANY($1)`, [
      [near.id, far.id],
    ]);
  });

  it("два заказа рядом одновременно не получают одного курьера", async () => {
    const spot = north(10_000);
    const only = await addCourier(north(200, spot));

    const results = await Promise.all([request(randomUUID(), spot), request(randomUUID(), spot)]);

    const offers = await db.query(
      `SELECT delivery_id FROM delivery_assignments WHERE courier_id = $1`,
      [only.id],
    );
    expect(offers).toHaveLength(1);
    expect(results).toHaveLength(2);
  });

  it("двадцать одновременных запросов курьера по заказу — одна доставка", async () => {
    const orderId = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => request(orderId, north(20_000))),
    );

    expect(new Set(answers.map((a) => a.deliveryId)).size).toBe(1);
    const [{ count }] = await db.query(`SELECT count(*) FROM deliveries WHERE order_id = $1`, [
      orderId,
    ]);
    expect(Number(count)).toBe(1);
  });

  it("молчание — следующему; курьер-молчун снова свободен; цепочка в таблице (DLV-4)", async () => {
    const spot = north(30_000);
    const first = await addCourier(north(100, spot));
    const second = await addCourier(north(900, spot));
    const orderId = randomUUID();
    const { deliveryId } = await request(orderId, spot);

    await dispatch.expireOffers(new Date(Date.now() + 91_000));

    expect(await openOfferOf(second.id)).toMatchObject({ sequence: 2 });
    const [status] = await db.query(`SELECT status FROM couriers WHERE id = $1`, [first.id]);
    expect(status.status).toBe("available");
    const chain = await db.query(
      `SELECT sequence, response FROM delivery_assignments WHERE delivery_id = $1 ORDER BY sequence`,
      [deliveryId],
    );
    expect(chain).toEqual([
      { sequence: 1, response: "TIMEOUT" },
      { sequence: 2, response: null },
    ]);
  });

  it("курьер проходит путь до вручения; события в outbox с ключом заказа", async () => {
    const spot = north(40_000);
    const courier = await addCourier(north(100, spot));
    const orderId = randomUUID();
    const { deliveryId } = await request(orderId, spot);
    const me = { userId: courier.userId };

    await couriers.accept(me, (await openOfferOf(courier.id))!.id);
    await couriers.pickedUp(me, deliveryId);
    await couriers.delivered(me, deliveryId);

    const events = await db.query(
      `SELECT event_type FROM outbox_messages WHERE headers->>'partitionKey' = $1 ORDER BY id`,
      [orderId],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      DELIVERY_EVENT_TYPES.courierAssigned,
      DELIVERY_EVENT_TYPES.courierAccepted,
      DELIVERY_EVENT_TYPES.orderPickedUp,
      DELIVERY_EVENT_TYPES.deliveryCompleted,
    ]);
  });

  it("история координат пишется пачкой и обновляет позицию для подбора", async () => {
    const courier = await addCourier(north(50_000));
    const at = new Date();
    for (let i = 0; i < 25; i += 1) {
      history.add(courier.id, { ...north(50_000 + i * 10), at: new Date(at.getTime() + i * 1000) });
    }

    expect(await history.flush()).toBe(25);
    const [{ count }] = await db.query(
      `SELECT count(*) FROM courier_locations WHERE courier_id = $1`,
      [courier.id],
    );
    expect(Number(count)).toBe(25);
    const [row] = await db.query(`SELECT last_location_at FROM couriers WHERE id = $1`, [
      courier.id,
    ]);
    expect(new Date(row.last_location_at).getTime()).toBe(at.getTime() + 24_000);
  });
});
