import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type {
  OrderHistoryView,
  OrderListFilter,
  OrderReadModel,
  OrderView,
} from "../../application/ports/order-read-model";
import {
  ORDER_COLUMNS,
  groupLines,
  toView,
  type ItemRow,
  type OptionRow,
  type OrderRow,
} from "./order.rows";

/** Статусы, которые видит кухня: принять, готовить, отдать курьеру (KIT-1). */
const KITCHEN_STATUSES = ["AWAITING_RESTAURANT", "COOKING", "READY", "ASSIGNING_COURIER"];

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

/**
 * Сторона чтения: готовые представления прямыми выборками по индексам
 * из миграции — история клиента, очередь кухни, очередь оператора.
 */
@Injectable()
export class TypeOrmOrderReadModel implements OrderReadModel {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get(orderId: string): Promise<OrderView | null> {
    if (!isUuid(orderId)) return null;
    const [view] = await this.select(`WHERE o.id = $1`, [orderId]);
    return view ?? null;
  }

  listByCustomer(customerId: string, limit: number, offset: number) {
    return this.select(`WHERE o.customer_id = $1 ORDER BY o.placed_at DESC LIMIT $2 OFFSET $3`, [
      customerId,
      limit,
      offset,
    ]);
  }

  async kitchenQueue(restaurantId: string) {
    const views = await this.select(
      `WHERE o.restaurant_id = $1 AND o.status = ANY($2::varchar[]) ORDER BY o.placed_at`,
      [restaurantId, KITCHEN_STATUSES],
    );
    if (views.length === 0) return views;
    // Срок ответа ресторана — из того же таймера, по которому заказ
    // отменится сам (KIT-5): экран показывает ровно тот срок, что действует.
    const deadlines = (await this.dataSource.query(
      `SELECT order_id, fire_at FROM saga_timers
        WHERE order_id = ANY($1::uuid[])
          AND timer_type = 'TIMEOUT:AWAITING_RESTAURANT' AND fired_at IS NULL`,
      [views.map((view) => view.id)],
    )) as Array<{ order_id: string; fire_at: Date }>;
    const byOrder = new Map(deadlines.map((row) => [row.order_id, row.fire_at.toISOString()]));
    return views.map((view) => ({ ...view, respondBy: byOrder.get(view.id) ?? null }));
  }

  list(filter: OrderListFilter) {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (filter.statuses?.length) {
      parameters.push(filter.statuses);
      conditions.push(`o.status = ANY($${parameters.length}::varchar[])`);
    }
    if (filter.attentionOnly) conditions.push(`o.attention_at IS NOT NULL`);
    parameters.push(filter.limit, filter.offset);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = filter.attentionOnly ? "o.attention_at" : "o.placed_at DESC";
    return this.select(
      `${where} ORDER BY ${order} LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
  }

  async history(orderId: string): Promise<OrderHistoryView | null> {
    if (!isUuid(orderId)) return null;
    const transitions = (await this.dataSource.query(
      `SELECT from_status, to_status, actor_type, actor_id, reason, created_at
         FROM order_status_history WHERE order_id = $1 ORDER BY id`,
      [orderId],
    )) as Array<Record<string, unknown>>;
    const [saga] = (await this.dataSource.query(
      `SELECT id, status, current_step, state FROM order_sagas WHERE order_id = $1`,
      [orderId],
    )) as Array<{ id: string; status: string; current_step: string; state: { facts?: unknown } }>;
    if (!saga && transitions.length === 0) return null;

    const steps = saga
      ? ((await this.dataSource.query(
          `SELECT step_name, is_compensation, status, attempt, error, started_at, finished_at
             FROM saga_steps WHERE saga_id = $1 ORDER BY id`,
          [saga.id],
        )) as Array<Record<string, unknown>>)
      : [];
    const pending = (await this.dataSource.query(
      `SELECT timer_type, fire_at, attempts, last_error FROM saga_timers
        WHERE order_id = $1 AND fired_at IS NULL ORDER BY fire_at`,
      [orderId],
    )) as Array<Record<string, unknown>>;

    return {
      orderId,
      transitions: transitions.map((row) => ({
        from: (row.from_status as string | null) ?? null,
        to: row.to_status as string,
        actorType: row.actor_type as string,
        actorId: (row.actor_id as string | null) ?? null,
        reason: (row.reason as string | null) ?? null,
        at: iso(row.created_at as Date)!,
      })),
      saga: saga
        ? {
            status: saga.status,
            currentStep: saga.current_step,
            facts: saga.state?.facts ?? {},
            steps: steps.map((row) => ({
              step: row.step_name as string,
              isCompensation: row.is_compensation as boolean,
              status: row.status as string,
              attempt: Number(row.attempt),
              error: (row.error as string | null) ?? null,
              startedAt: iso(row.started_at as Date)!,
              finishedAt: iso(row.finished_at as Date | null),
            })),
          }
        : null,
      pending: pending.map((row) => ({
        type: row.timer_type as string,
        fireAt: iso(row.fire_at as Date)!,
        attempts: Number(row.attempts),
        lastError: (row.last_error as string | null) ?? null,
      })),
    };
  }

  private async select(clause: string, parameters: unknown[]): Promise<OrderView[]> {
    const rows = (await this.dataSource.query(
      `SELECT ${ORDER_COLUMNS} FROM orders o ${clause}`,
      parameters,
    )) as OrderRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const items = (await this.dataSource.query(
      `SELECT id, order_id, position, menu_item_id, name_snapshot, price_snapshot, quantity, line_total
         FROM order_items WHERE order_id = ANY($1::uuid[])`,
      [ids],
    )) as ItemRow[];
    const options = items.length
      ? ((await this.dataSource.query(
          `SELECT order_item_id, option_id, name_snapshot, price_delta_snapshot
             FROM order_item_options WHERE order_item_id = ANY($1::uuid[])`,
          [items.map((item) => item.id)],
        )) as OptionRow[])
      : [];
    const lines = groupLines(items, options);
    return rows.map((row) => toView(row, lines.get(row.id) ?? []));
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}
