import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { createLogger, type Logger } from "@food-delivery/shared";
import type { LocationHistory, Position } from "../../application/ports/positions";
import { DELIVERY_CONFIG, type DeliveryConfig } from "../../config/configuration";

interface Entry {
  courierId: string;
  position: Position;
}

/**
 * Пакетная запись истории координат.
 *
 * Координаты копятся в памяти и раз в несколько секунд уходят в базу
 * одним запросом: `courier_locations` — единственная таблица с высокой
 * частотой записи, и транзакция на каждую координату положила бы базу
 * задолго до целевого объёма. Тем же запросом обновляется последняя
 * позиция курьера в `couriers` — по ней идёт подбор (DLV-3).
 *
 * Цена решения названа прямо: при падении процесса теряются координаты
 * за последние несколько секунд. История нужна для разбора спорных
 * доставок, а не для отображения, — такая потеря допустима.
 */
@Injectable()
export class BatchedLocationHistory
  implements LocationHistory, OnApplicationBootstrap, OnApplicationShutdown
{
  private buffer: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly logger: Logger;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(DELIVERY_CONFIG) private readonly config: DeliveryConfig,
  ) {
    this.logger = createLogger({ service: "delivery", level: config.logLevel }).child({
      component: "location-history",
    });
  }

  add(courierId: string, position: Position): void {
    if (this.buffer.length >= this.config.locations.maxBuffer) {
      // База недоступна долго: старые точки уступают место новым.
      this.buffer.shift();
    }
    this.buffer.push({ courierId, position });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.flush(), this.config.locations.flushIntervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Записать накопленное. Возвращает число записанных точек. */
  async flush(): Promise<number> {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO courier_locations (courier_id, location, speed, accuracy, recorded_at)
           SELECT u.courier_id,
                  ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography,
                  u.speed, u.accuracy, u.recorded_at
             FROM unnest($1::uuid[], $2::float8[], $3::float8[], $4::numeric[], $5::numeric[],
                         $6::timestamptz[])
               AS u(courier_id, lat, lon, speed, accuracy, recorded_at)`,
          [
            batch.map((e) => e.courierId),
            batch.map((e) => e.position.latitude),
            batch.map((e) => e.position.longitude),
            batch.map((e) => e.position.speed ?? null),
            batch.map((e) => e.position.accuracy ?? null),
            batch.map((e) => e.position.at),
          ],
        );

        // Последняя позиция каждого курьера из пачки — для подбора.
        const latest = new Map<string, Entry>();
        for (const entry of batch) latest.set(entry.courierId, entry);
        const rows = [...latest.values()];
        await manager.query(
          `UPDATE couriers c
              SET last_location = ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography,
                  last_location_at = u.recorded_at
             FROM unnest($1::uuid[], $2::float8[], $3::float8[], $4::timestamptz[])
               AS u(courier_id, lat, lon, recorded_at)
            WHERE c.id = u.courier_id
              AND (c.last_location_at IS NULL OR c.last_location_at < u.recorded_at)`,
          [
            rows.map((e) => e.courierId),
            rows.map((e) => e.position.latitude),
            rows.map((e) => e.position.longitude),
            rows.map((e) => e.position.at),
          ],
        );
      });
      return batch.length;
    } catch (error) {
      // Вернуть точки в начало буфера: следующая попытка запишет их.
      this.buffer = [...batch, ...this.buffer].slice(-this.config.locations.maxBuffer);
      this.logger.warn("история координат не записана, повтор на следующем шаге", {
        points: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.flushing = false;
    }
  }
}
