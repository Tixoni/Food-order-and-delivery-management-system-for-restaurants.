import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { MetricsService } from "@food-delivery/service-kit";
import { Gauge } from "prom-client";
import type { DataSource } from "typeorm";

const metrics = [
  {
    name: "orders_placed_last_minute",
    help: "Orders placed in the last minute",
    sql: "SELECT count(*) AS value FROM orders WHERE placed_at >= now() - interval '1 minute'",
  },
  {
    name: "orders_cancelled_ratio_24h",
    help: "Share of orders placed in the last 24 hours which are currently cancelled",
    sql: `
      SELECT count(*) FILTER (WHERE status = 'CANCELLED')::double precision
           / nullif(count(*), 0) AS value
        FROM orders WHERE placed_at >= now() - interval '24 hours'`,
  },
  {
    name: "orders_capture_to_delivery_seconds_24h",
    help: "Mean seconds from successful payment capture for orders delivered in the last 24 hours",
    sql: `
      SELECT avg(extract(epoch FROM o.delivered_at - capture.at)) AS value
        FROM orders o
        JOIN order_sagas saga ON saga.order_id = o.id
        CROSS JOIN LATERAL (
          SELECT coalesce(
            (saga.state->'facts'->>'paymentCapturedAt')::timestamptz,
            (SELECT min(step.finished_at) FROM saga_steps step
              WHERE step.saga_id = saga.id
                AND step.step_name = 'CAPTURE_PAYMENT' AND step.status = 'SUCCEEDED')
          ) AS at
        ) capture
       WHERE o.delivered_at >= now() - interval '24 hours' AND capture.at <= o.delivered_at`,
  },
];

/** Агрегаты читаются из базы заказов и переживают перезапуск сервиса. */
@Injectable()
export class OrderMetrics {
  constructor(@InjectDataSource() database: DataSource, registry: MetricsService) {
    for (const { name, help, sql } of metrics) {
      new Gauge({
        name,
        help,
        registers: [registry.registry],
        async collect() {
          const [row] = (await database.query(sql)) as Array<{ value: string | number | null }>;
          if (row?.value == null) this.reset();
          else this.set(Number(row.value));
        },
      });
    }
  }
}
