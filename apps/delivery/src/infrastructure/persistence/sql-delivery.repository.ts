import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource, EntityManager } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import { Courier, type CourierState } from "../../domain/courier";
import { Delivery, Offer, type DeliveryState, type OfferState } from "../../domain/delivery";
import type { GeoPoint, VehicleType } from "../../domain/geo";
import {
  DuplicateDeliveryError,
  type Candidate,
  type CourierDashboard,
  type DeliveryRepository,
  type DeliveryTx,
  type LocationContext,
} from "../../application/ports/delivery.repository";

/**
 * Хранилище доставки на PostgreSQL + PostGIS.
 *
 * Подбор (DLV-3) — один запрос по пространственному индексу:
 * `ST_DWithin` отсекает курьеров дальше радиуса, `<->` сортирует от
 * ближнего (KNN по GiST), `FOR UPDATE … SKIP LOCKED` блокирует выбранного
 * и пропускает тех, кого прямо сейчас предлагает другой экземпляр сервиса.
 */

const COURIER_COLUMNS = `
  c.id, c.user_id, c.full_name, c.phone, c.vehicle_type, c.status,
  c.current_delivery_id, c.is_active, c.last_location_at,
  ST_Y(c.last_location::geometry) AS lat, ST_X(c.last_location::geometry) AS lon`;

const DELIVERY_COLUMNS = `
  d.id, d.order_id, d.restaurant_id, d.customer_id, d.order_number, d.dropoff_address,
  d.contact_phone, d.status, d.courier_id, d.ready_at,
  d.request_key, d.correlation_id, d.created_at, d.accepted_at, d.picked_up_at,
  d.delivered_at, d.cancelled_at, d.not_found_at, d.search_started_at, d.version,
  ST_Y(d.pickup_location::geometry) AS pickup_lat, ST_X(d.pickup_location::geometry) AS pickup_lon,
  ST_Y(d.dropoff_location::geometry) AS dropoff_lat, ST_X(d.dropoff_location::geometry) AS dropoff_lon`;

const OFFER_COLUMNS = `
  a.id, a.delivery_id, a.courier_id, a.sequence, a.offered_at, a.expires_at,
  a.responded_at, a.response`;

const POINT = (lon: string, lat: string) =>
  `ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;

/** Нарушение уникальности в PostgreSQL. */
const UNIQUE_VIOLATION = "23505";

@Injectable()
export class SqlDeliveryRepository implements DeliveryRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  transaction<T>(work: (tx: DeliveryTx) => Promise<T>): Promise<T> {
    return this.dataSource.transaction((manager) => work(new SqlDeliveryTx(manager)));
  }

  async dashboard(userId: string): Promise<CourierDashboard | null> {
    const [courierRow] = await this.dataSource.query(
      `SELECT ${COURIER_COLUMNS} FROM couriers c WHERE c.user_id = $1`,
      [userId],
    );
    if (!courierRow) return null;
    const courier = toCourier(courierRow);

    const [offerRow] = await this.dataSource.query(
      `SELECT ${OFFER_COLUMNS} FROM delivery_assignments a
        WHERE a.courier_id = $1 AND a.response IS NULL`,
      [courier.id],
    );
    const offerDelivery = offerRow ? await this.deliveryById(offerRow.delivery_id) : null;
    const current = courier.snapshot.currentDeliveryId
      ? await this.deliveryById(courier.snapshot.currentDeliveryId)
      : null;

    return {
      courier,
      offer:
        offerRow && offerDelivery ? { offer: toOffer(offerRow), delivery: offerDelivery } : null,
      delivery: current,
    };
  }

  async deliveryOfOrder(orderId: string) {
    const [row] = await this.dataSource.query(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries d
        WHERE d.order_id = $1 ORDER BY d.created_at DESC LIMIT 1`,
      [orderId],
    );
    return row ? toDelivery(row) : null;
  }

  async locationContext(userId: string): Promise<LocationContext | null> {
    const [row] = await this.dataSource.query(
      `SELECT c.id, c.status, d.order_id
         FROM couriers c
         LEFT JOIN deliveries d ON d.id = c.current_delivery_id
        WHERE c.user_id = $1`,
      [userId],
    );
    return row ? { courierId: row.id, status: row.status, orderId: row.order_id ?? null } : null;
  }

  async listCouriers() {
    const rows = await this.dataSource.query(
      `SELECT ${COURIER_COLUMNS} FROM couriers c ORDER BY c.full_name`,
    );
    return rows.map(toCourier);
  }

  private async deliveryById(id: string) {
    const [row] = await this.dataSource.query(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries d WHERE d.id = $1`,
      [id],
    );
    return row ? toDelivery(row) : null;
  }
}

export class SqlDeliveryTx implements DeliveryTx {
  constructor(private readonly manager: EntityManager) {}

  private query<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []) {
    return this.manager.query(sql, parameters) as Promise<T[]>;
  }

  async deliveryById(id: string) {
    const [row] = await this.query(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries d WHERE d.id = $1 FOR UPDATE`,
      [id],
    );
    return row ? toDelivery(row) : null;
  }

  async activeDeliveryByOrder(orderId: string) {
    const [row] = await this.query(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries d
        WHERE d.order_id = $1 AND d.status NOT IN ('CANCELLED', 'DELIVERED')
        FOR UPDATE`,
      [orderId],
    );
    return row ? toDelivery(row) : null;
  }

  async insertDelivery(delivery: Delivery) {
    const s = delivery.snapshot;
    try {
      await this.query(
        `INSERT INTO deliveries
           (id, order_id, restaurant_id, customer_id, pickup_location, dropoff_location,
            status, ready_at, request_key, correlation_id, created_at,
            order_number, dropoff_address, contact_phone, search_started_at)
         VALUES ($1, $2, $3, $4, ${POINT("$5", "$6")}, ${POINT("$7", "$8")},
                 $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          s.id,
          s.orderId,
          s.restaurantId,
          s.customerId,
          s.pickup.longitude,
          s.pickup.latitude,
          s.dropoff.longitude,
          s.dropoff.latitude,
          s.status,
          s.readyAt,
          s.requestKey,
          s.correlationId,
          s.createdAt,
          s.orderNumber,
          s.dropoffAddress,
          s.contactPhone,
          s.searchStartedAt,
        ],
      );
    } catch (error) {
      // ux_deliveries_order_active: одновременный запрос успел первым
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateDeliveryError(s.orderId);
      }
      throw error;
    }
  }

  async saveDelivery(delivery: Delivery) {
    const s = delivery.snapshot;
    await this.query(
      `UPDATE deliveries
          SET status = $2, courier_id = $3, request_key = $4, not_found_at = $5,
              accepted_at = $6, assigned_at = COALESCE(assigned_at, $6), picked_up_at = $7,
              delivered_at = $8, cancelled_at = $9, search_started_at = $10,
              version = version + 1
        WHERE id = $1`,
      [
        s.id,
        s.status,
        s.courierId,
        s.requestKey,
        s.notFoundAt,
        s.acceptedAt,
        s.pickedUpAt,
        s.deliveredAt,
        s.cancelledAt,
        s.searchStartedAt,
      ],
    );
  }

  async courierById(id: string) {
    const [row] = await this.query(
      `SELECT ${COURIER_COLUMNS} FROM couriers c WHERE c.id = $1 FOR UPDATE`,
      [id],
    );
    return row ? toCourier(row) : null;
  }

  async courierByUser(userId: string) {
    const [row] = await this.query(
      `SELECT ${COURIER_COLUMNS} FROM couriers c WHERE c.user_id = $1 FOR UPDATE`,
      [userId],
    );
    return row ? toCourier(row) : null;
  }

  async insertCourier(courier: Courier) {
    const s = courier.snapshot;
    await this.query(
      `INSERT INTO couriers (id, user_id, full_name, phone, vehicle_type, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.id, s.userId, s.fullName, s.phone, s.vehicleType, s.status, s.isActive],
    );
  }

  async saveCourier(courier: Courier) {
    const s = courier.snapshot;
    await this.query(
      `UPDATE couriers SET status = $2, current_delivery_id = $3, is_active = $4 WHERE id = $1`,
      [s.id, s.status, s.currentDeliveryId, s.isActive],
    );
  }

  async openShift(courierId: string, at: Date) {
    await this.query(
      `INSERT INTO courier_shifts (courier_id, started_at) VALUES ($1, $2)
       ON CONFLICT (courier_id) WHERE ended_at IS NULL DO NOTHING`,
      [courierId, at],
    );
  }

  async closeShift(courierId: string, at: Date) {
    await this.query(
      `UPDATE courier_shifts SET ended_at = GREATEST($2, started_at + interval '1 millisecond')
        WHERE courier_id = $1 AND ended_at IS NULL`,
      [courierId, at],
    );
  }

  async nearestCandidate(
    delivery: Delivery,
    radiusMeters: number,
    freshSeconds: number,
  ): Promise<Candidate | null> {
    const { pickup } = delivery.snapshot;
    const point = POINT("$1", "$2");
    // Два шага, а не один запрос с FOR UPDATE: если планировщик выбирает
    // сортировку по расстоянию прямо через GiST-индекс (KNN), блокировка
    // строк на таком сканировании падает с «attempted to lock invisible
    // tuple» — найдено на живой проверке, план зависит от статистики.
    // Поэтому ближайшие кандидаты выбираются отдельно (MATERIALIZED не даёт
    // планировщику склеить шаги обратно), а блокируется строка курьера по
    // первичному ключу; условие на статус при этом перепроверяется по
    // свежей версии строки — курьер, которого только что занял другой
    // экземпляр, отсеется.
    const [row] = await this.query(
      `WITH nearest AS MATERIALIZED (
         SELECT c.id, c.last_location <-> ${point} AS distance
           FROM couriers c
          WHERE c.status = 'available'
            AND c.is_active
            AND c.user_id IS NOT NULL
            AND c.last_location_at > now() - make_interval(secs => $3)
            AND ST_DWithin(c.last_location, ${point}, $4)
            AND NOT EXISTS (
                  SELECT 1 FROM delivery_assignments a
                   WHERE a.delivery_id = $5 AND a.courier_id = c.id
                     AND a.offered_at >= $6)
          ORDER BY c.last_location <-> ${point}
          LIMIT 10)
       SELECT ${COURIER_COLUMNS}, n.distance
         FROM nearest n
         JOIN couriers c ON c.id = n.id
        WHERE c.status = 'available'
        ORDER BY n.distance
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED`,
      [
        pickup.longitude,
        pickup.latitude,
        freshSeconds,
        radiusMeters,
        delivery.id,
        delivery.snapshot.searchStartedAt,
      ],
    );
    return row ? { courier: toCourier(row), distanceMeters: Number(row.distance) } : null;
  }

  async openOfferOf(deliveryId: string) {
    const [row] = await this.query(
      `SELECT ${OFFER_COLUMNS} FROM delivery_assignments a
        WHERE a.delivery_id = $1 AND a.response IS NULL FOR UPDATE`,
      [deliveryId],
    );
    return row ? toOffer(row) : null;
  }

  async offerById(id: string) {
    const [row] = await this.query(
      `SELECT ${OFFER_COLUMNS} FROM delivery_assignments a WHERE a.id = $1 FOR UPDATE`,
      [id],
    );
    return row ? toOffer(row) : null;
  }

  async offersCount(deliveryId: string) {
    const [row] = await this.query<{ count: string }>(
      `SELECT count(*) FROM delivery_assignments WHERE delivery_id = $1`,
      [deliveryId],
    );
    return Number(row.count);
  }

  async insertOffer(offer: Offer) {
    const s = offer.snapshot;
    await this.query(
      `INSERT INTO delivery_assignments (id, delivery_id, courier_id, sequence, offered_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.id, s.deliveryId, s.courierId, s.sequence, s.offeredAt, s.expiresAt],
    );
  }

  async saveOffer(offer: Offer) {
    const s = offer.snapshot;
    await this.query(
      `UPDATE delivery_assignments SET response = $2, responded_at = $3 WHERE id = $1`,
      [s.id, s.response, s.respondedAt],
    );
  }

  async dueOffers(now: Date, limit: number) {
    const rows = await this.query(
      `SELECT ${OFFER_COLUMNS} FROM delivery_assignments a
        WHERE a.response IS NULL AND a.expires_at <= $1
        ORDER BY a.expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOffer);
  }

  async enqueue(events: DomainEvent[], orderId: string) {
    for (const event of events) {
      await this.query(
        `INSERT INTO outbox_messages (aggregate_type, aggregate_id, event_type, event_version, payload, headers)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          event.aggregateType,
          event.aggregateId,
          event.eventType,
          event.eventVersion,
          JSON.stringify(event),
          JSON.stringify({
            // События одного заказа — в одну партицию, по порядку.
            partitionKey: orderId,
            correlationId: event.correlationId,
            ...(event.causationId ? { causationId: event.causationId } : {}),
          }),
        ],
      );
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- строки из драйвера */
function point(lat: any, lon: any): GeoPoint | null {
  return lat === null || lat === undefined
    ? null
    : { latitude: Number(lat), longitude: Number(lon) };
}

function toCourier(row: any): Courier {
  const state: CourierState = {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    phone: row.phone,
    vehicleType: row.vehicle_type as VehicleType,
    status: row.status,
    currentDeliveryId: row.current_delivery_id,
    isActive: row.is_active,
    lastLocation: point(row.lat, row.lon),
    lastLocationAt: row.last_location_at,
  };
  return Courier.restore(state);
}

function toDelivery(row: any): Delivery {
  const state: DeliveryState = {
    id: row.id,
    orderId: row.order_id,
    restaurantId: row.restaurant_id,
    customerId: row.customer_id,
    orderNumber: row.order_number === null ? null : Number(row.order_number),
    pickup: point(row.pickup_lat, row.pickup_lon)!,
    dropoff: point(row.dropoff_lat, row.dropoff_lon)!,
    dropoffAddress: row.dropoff_address,
    contactPhone: row.contact_phone,
    status: row.status,
    courierId: row.courier_id,
    readyAt: row.ready_at,
    requestKey: row.request_key,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    notFoundAt: row.not_found_at,
    searchStartedAt: row.search_started_at ?? row.created_at,
    version: Number(row.version),
  };
  return Delivery.restore(state);
}

function toOffer(row: any): Offer {
  const state: OfferState = {
    id: row.id,
    deliveryId: row.delivery_id,
    courierId: row.courier_id,
    sequence: Number(row.sequence),
    offeredAt: row.offered_at,
    expiresAt: row.expires_at,
    respondedAt: row.responded_at,
    response: row.response,
  };
  return Offer.restore(state);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
