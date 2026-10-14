import { Injectable } from "@nestjs/common";
import { traceHeaders } from "@food-delivery/service-kit";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, type EntityManager } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import { CheckoutSaga } from "../../domain/checkout-saga";
import type { Order } from "../../domain/order";
import {
  ConcurrentModificationError,
  DuplicateMessageError,
  DuplicateOrderError,
  type LoadedOrder,
  type OrderChangeSet,
  type OrderRepository,
  type SagaStepRecord,
} from "../../application/ports/order.repository";
import type { ClaimedEntry, SagaQueue } from "../../application/ports/saga-queue";
import {
  ORDER_COLUMNS,
  groupLines,
  sagaToDomain,
  toDomain,
  type ItemRow,
  type OptionRow,
  type OrderRow,
  type SagaRow,
} from "./order.rows";

const UNIQUE_VIOLATION = "23505";

const point = (location: { latitude: number; longitude: number } | null) =>
  location ? `SRID=4326;POINT(${location.longitude} ${location.latitude})` : null;

/**
 * Хранилище заказов поверх PostgreSQL.
 *
 * Главное обещание порта: заказ, история переходов, состояние саги, её шаги
 * и таймеры, исходящие события и отметка об обработанном сообщении
 * сохраняются одной транзакцией. Либо всё, либо ничего (REL-3, REL-4).
 */
@Injectable()
export class TypeOrmOrderRepository implements OrderRepository, SagaQueue {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async nextOrderNumber(): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT nextval(pg_get_serial_sequence('orders', 'order_number')) AS value`,
    );
    return Number(row.value);
  }

  async findById(orderId: string): Promise<LoadedOrder | null> {
    if (!isUuid(orderId)) return null;
    const [row] = (await this.dataSource.query(
      `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1`,
      [orderId],
    )) as OrderRow[];
    if (!row) return null;
    const [sagaRow] = (await this.dataSource.query(
      `SELECT id, order_id, current_step, state, status, version FROM order_sagas WHERE order_id = $1`,
      [orderId],
    )) as SagaRow[];
    if (!sagaRow) return null;
    const lines = await this.loadLines([orderId]);
    return {
      order: toDomain(row, lines.get(orderId) ?? []),
      saga: CheckoutSaga.restore(sagaToDomain(sagaRow)),
    };
  }

  async findByIdempotencyKey(customerId: string, key: string): Promise<Order | null> {
    const [row] = (await this.dataSource.query(
      `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.customer_id = $1 AND o.idempotency_key = $2`,
      [customerId, key],
    )) as OrderRow[];
    if (!row) return null;
    const lines = await this.loadLines([row.id]);
    return toDomain(row, lines.get(row.id) ?? []);
  }

  async create(change: OrderChangeSet): Promise<void> {
    const { order, saga } = change;
    const state = order.snapshot();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO orders (
             id, order_number, customer_id, restaurant_id, status, delivery_address_text,
             delivery_location, pickup_location, contact_phone, items_amount, delivery_fee,
             service_fee, discount_amount, total_amount, comment, idempotency_key, placed_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7::geography, $8::geography, $9, $10, $11,
                   $12, $13, $14, $15, $16, $17, 1)`,
          [
            state.id,
            state.orderNumber,
            state.customerId,
            state.restaurantId,
            state.status,
            state.addressText,
            point(state.location),
            point(state.pickup),
            state.contactPhone,
            state.amounts.items,
            state.amounts.delivery,
            state.amounts.service,
            state.amounts.discount,
            state.amounts.total,
            state.comment,
            state.idempotencyKey,
            state.placedAt,
          ],
        );

        for (const [index, line] of state.lines.entries()) {
          const [item] = await manager.query(
            `INSERT INTO order_items
               (order_id, position, menu_item_id, name_snapshot, price_snapshot, quantity, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              state.id,
              index + 1,
              line.menuItemId,
              line.name,
              line.basePrice,
              line.quantity,
              line.lineTotal,
            ],
          );
          for (const option of line.options) {
            await manager.query(
              `INSERT INTO order_item_options
                 (order_item_id, option_id, name_snapshot, price_delta_snapshot)
               VALUES ($1, $2, $3, $4)`,
              [item.id, option.optionId, option.name, option.priceDelta],
            );
          }
        }

        const sagaState = saga.snapshot();
        await manager.query(
          `INSERT INTO order_sagas (id, order_id, current_step, state, status, version)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [
            sagaState.id,
            sagaState.orderId,
            sagaState.currentStep,
            JSON.stringify({ correlationId: sagaState.correlationId, facts: sagaState.facts }),
            sagaState.status,
          ],
        );

        await this.writeRest(manager, change);
      });
    } catch (error) {
      if (isUniqueViolation(error, "ux_orders_idempotency_key")) throw new DuplicateOrderError();
      throw error;
    }
    order.markPersisted(1);
    saga.markPersisted(1);
  }

  async save(change: OrderChangeSet): Promise<void> {
    const { order, saga } = change;
    const state = order.snapshot();
    const sagaState = saga.snapshot();

    await this.dataSource.transaction(async (manager) => {
      // Отметка о сообщении — первой: повтор отсекается раньше любых изменений.
      if (change.inbox) {
        const inserted = await manager.query(
          `INSERT INTO inbox_messages (message_id, consumer, event_type)
           VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
          [change.inbox.messageId, change.inbox.consumer, change.inbox.eventType],
        );
        if (inserted.length === 0) throw new DuplicateMessageError(change.inbox.messageId);
      }

      // Оптимистичная блокировка: изменение проходит, только если с момента
      // чтения заказ никто не менял. Иначе — конфликт, сценарий перечитает.
      const [, orderUpdated] = await manager.query(
        `UPDATE orders SET
           status = $3, expected_cooking_min = $4, confirmed_at = $5, ready_at = $6,
           picked_up_at = $7, delivered_at = $8, cancelled_at = $9, cancel_reason = $10,
           cancel_comment = $11, attention_reason = $12, attention_at = $13,
           version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [
          state.id,
          state.version,
          state.status,
          state.expectedCookingMin,
          state.confirmedAt,
          state.readyAt,
          state.pickedUpAt,
          state.deliveredAt,
          state.cancelledAt,
          state.cancelReason,
          state.cancelComment,
          state.attentionReason,
          state.attentionAt,
        ],
      );
      if (orderUpdated !== 1)
        throw new ConcurrentModificationError("заказ изменён одновременно другим действием");

      const [, sagaUpdated] = await manager.query(
        `UPDATE order_sagas SET current_step = $3, state = $4, status = $5,
           version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [
          sagaState.id,
          sagaState.version,
          sagaState.currentStep,
          JSON.stringify({ correlationId: sagaState.correlationId, facts: sagaState.facts }),
          sagaState.status,
        ],
      );
      if (sagaUpdated !== 1) {
        throw new ConcurrentModificationError("сага изменена одновременно другим действием");
      }

      await this.writeRest(manager, change);
    });

    order.markPersisted(state.version + 1);
    saga.markPersisted(sagaState.version + 1);
  }

  /** История, шаги, очередь саги и события — общая часть создания и изменения. */
  private async writeRest(manager: EntityManager, change: OrderChangeSet) {
    const orderId = change.order.id;
    const sagaId = change.saga.id;

    for (const entry of change.history) {
      await manager.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, entry.from, entry.to, entry.actor.type, entry.actor.id, entry.reason, entry.at],
      );
    }

    // Порядок важен: сначала завершить выполненный шаг и снять ненужные
    // записи, потом поставить новые — иначе новая запись того же типа
    // упёрлась бы в ещё активную старую.
    if (change.completeEntryId) {
      await manager.query(
        `UPDATE saga_timers SET fired_at = now() WHERE id = $1 AND fired_at IS NULL`,
        [change.completeEntryId],
      );
    }
    if (change.cancel?.length) {
      await manager.query(
        `UPDATE saga_timers SET fired_at = now(), last_error = COALESCE(last_error, 'снят')
          WHERE order_id = $1 AND timer_type = ANY($2::varchar[]) AND fired_at IS NULL`,
        [orderId, [...new Set(change.cancel)]],
      );
    }
    for (const entry of change.schedule ?? []) {
      await manager.query(
        `INSERT INTO saga_timers (saga_id, order_id, timer_type, fire_at, trace_context)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_id, timer_type) WHERE fired_at IS NULL
         DO UPDATE SET fire_at = EXCLUDED.fire_at, attempts = 0, last_error = NULL,
                       trace_context = EXCLUDED.trace_context`,
        // Контекст трассы, в которой шаг поставлен: фоновый исполнитель
        // продолжит её, а не начнёт новую (OBS-2)
        [sagaId, orderId, entry.type, entry.fireAt, JSON.stringify(traceHeaders())],
      );
    }

    for (const step of change.steps ?? []) await insertStep(manager, sagaId, step);
    await writeOutbox(manager, change.events);
  }

  /* ─────────────── Очередь саги ─────────────── */

  /**
   * Взять наступившие записи «в аренду»: срок отодвигается на время аренды,
   * счётчик попыток растёт. `SKIP LOCKED` — две реплики не возьмут одно и то же.
   *
   * Время — часы сервиса (`$3`), а не `now()` базы: сроки в `fire_at` пишет
   * сервис по своим часам. Сравнение с часами базы смешивало двое часов —
   * найдено замером PERF-4: часы Docker-машины уходили от часов Windows на
   * секунды, и первый шаг саги ждал 2–4,5 с вместо долей секунды.
   */
  async claimDue(limit: number, leaseMs: number, now = new Date()): Promise<ClaimedEntry[]> {
    const rows = (await this.dataSource.query(
      `UPDATE saga_timers t
          SET fire_at = $3::timestamptz + ($2::int * interval '1 millisecond'),
              attempts = t.attempts + 1
         FROM (SELECT id FROM saga_timers
                WHERE fired_at IS NULL AND fire_at <= $3
                ORDER BY fire_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED) due
        WHERE t.id = due.id
        RETURNING t.id, t.order_id, t.saga_id, t.timer_type, t.attempts, t.trace_context`,
      [limit, leaseMs, now],
    )) as unknown;
    // Для UPDATE ... RETURNING драйвер возвращает пару [строки, число строк].
    const list = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<{
      id: string;
      order_id: string;
      saga_id: string;
      timer_type: string;
      attempts: number;
      trace_context: Record<string, string> | null;
    }>;
    return list.map((row) => ({
      id: String(row.id),
      orderId: row.order_id,
      sagaId: row.saga_id,
      type: row.timer_type,
      attempt: Number(row.attempts),
      traceContext: row.trace_context,
    }));
  }

  async retryLater(entry: ClaimedEntry, fireAt: Date, error: string, step: SagaStepRecord) {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE saga_timers SET fire_at = $2, last_error = $3 WHERE id = $1 AND fired_at IS NULL`,
        [entry.id, fireAt, error.slice(0, 1000)],
      );
      await insertStep(manager, entry.sagaId, step);
    });
  }

  async discard(entry: ClaimedEntry, reason: string) {
    await this.dataSource.query(
      `UPDATE saga_timers SET fired_at = now(), last_error = $2 WHERE id = $1 AND fired_at IS NULL`,
      [entry.id, reason.slice(0, 1000)],
    );
  }

  private async loadLines(orderIds: string[]) {
    const items = (await this.dataSource.query(
      `SELECT id, order_id, position, menu_item_id, name_snapshot, price_snapshot, quantity, line_total
         FROM order_items WHERE order_id = ANY($1::uuid[])`,
      [orderIds],
    )) as ItemRow[];
    const options = items.length
      ? ((await this.dataSource.query(
          `SELECT order_item_id, option_id, name_snapshot, price_delta_snapshot
             FROM order_item_options WHERE order_item_id = ANY($1::uuid[])`,
          [items.map((item) => item.id)],
        )) as OptionRow[])
      : [];
    return groupLines(items, options);
  }
}

async function insertStep(manager: EntityManager, sagaId: string, step: SagaStepRecord) {
  await manager.query(
    `INSERT INTO saga_steps
       (saga_id, step_name, is_compensation, status, attempt, request, response, error, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sagaId,
      step.step,
      step.isCompensation,
      step.status,
      Math.min(step.attempt, 32767),
      step.request === undefined ? null : JSON.stringify(step.request),
      step.response === undefined ? null : JSON.stringify(step.response),
      step.error ?? null,
      step.startedAt,
      step.finishedAt,
    ],
  );
}

/**
 * Исходящие события — той же транзакцией, что и изменение заказа (REL-3).
 * Ключ партиции — заказ: все события одного заказа читаются по порядку.
 */
async function writeOutbox(manager: EntityManager, events: readonly DomainEvent[]) {
  for (const event of events) {
    await manager.query(
      `INSERT INTO outbox_messages (aggregate_type, aggregate_id, event_type, event_version, payload, headers)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        event.eventVersion,
        JSON.stringify(event),
        JSON.stringify({
          partitionKey: event.aggregateId,
          correlationId: event.correlationId,
          ...(event.causationId ? { causationId: event.causationId } : {}),
          // Контекст трассы — отправка из outbox продолжит эту трассу (OBS-2)
          ...traceHeaders(),
        }),
      ],
    );
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError;
  const direct = error as { code?: string; constraint?: string };
  const source = driver ?? direct;
  return source?.code === UNIQUE_VIOLATION && source?.constraint === constraint;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}
