import { Injectable } from "@nestjs/common";
import { traceHeaders } from "@food-delivery/service-kit";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource, EntityManager } from "typeorm";
import { ConflictError, type DomainEvent } from "@food-delivery/shared";
import { Payment, type PaymentState } from "../../domain/payment";
import type {
  Completion,
  PaymentHistory,
  PaymentRepository,
  StartedOperation,
  TransactionRecord,
} from "../../application/ports/payment.repository";

/**
 * Хранилище платежей на SQL.
 *
 * Запросы написаны вручную, как в сервисе заказов: в них и есть суть
 * идемпотентности — `ON CONFLICT DO NOTHING` по уникальному ключу и
 * завершение операции только поверх записи в статусе PENDING. ORM здесь
 * спрятал бы именно то, что нужно показать и проверить.
 *
 * Транзакция базы никогда не охватывает вызов провайдера: начало и итог
 * операции — две короткие транзакции, сетевой вызов — между ними.
 */

interface PaymentRow {
  id: string;
  order_id: string;
  customer_id: string;
  amount: number;
  refunded_amount: number;
  status: PaymentState["status"];
  provider_payment_id: string | null;
  authorized_at: Date | null;
  captured_at: Date | null;
  version: number;
}

interface TransactionRow {
  id: string;
  payment_id: string;
  type: TransactionRecord["type"];
  amount: number;
  status: TransactionRecord["status"];
  idempotency_key: string;
  request: TransactionRecord["request"] | null;
  response: TransactionRecord["outcome"];
  provider_ref: string | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Нарушение уникальности в PostgreSQL. */
const UNIQUE_VIOLATION = "23505";

@Injectable()
export class SqlPaymentRepository implements PaymentRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  startAuthorization(input: Parameters<PaymentRepository["startAuthorization"]>[0]) {
    return this.dataSource.transaction(async (manager) => {
      const known = await this.byKey(manager, input.idempotencyKey);
      if (known) return known;

      let inserted: PaymentRow[];
      try {
        inserted = await manager.query(
          `INSERT INTO payments (order_id, customer_id, amount, idempotency_key)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *`,
          [input.orderId, input.customerId, input.amount, input.idempotencyKey],
        );
      } catch (error) {
        // Второй действующий платёж по заказу с другим ключом — не повтор,
        // а ошибка вызывающего (ux_payments_order_active).
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictError("по заказу уже есть действующий платёж", {
            orderId: input.orderId,
          });
        }
        throw error;
      }

      // Пусто — одновременный повтор успел вставить платёж первым.
      if (inserted.length === 0) {
        const raced = await this.byKey(manager, input.idempotencyKey);
        if (raced) return raced;
        throw new ConflictError("операция с этим ключом ещё создаётся — повторите", {
          idempotencyKey: input.idempotencyKey,
        });
      }

      const transaction = await this.insertTransaction(manager, inserted[0].id, {
        type: "AUTHORIZE",
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
      return { payment: toPayment(inserted[0]), transaction };
    });
  }

  startOperation(
    orderId: string,
    idempotencyKey: string,
    correlationId: string,
    plan: Parameters<PaymentRepository["startOperation"]>[3],
  ) {
    return this.dataSource.transaction(async (manager) => {
      // Сначала ключ: повтор уже выполненной операции должен получить её
      // итог, даже если платёж с тех пор перешёл в другой статус.
      const known = await this.byKey(manager, idempotencyKey);
      if (known) return known;

      // Блокировка платежа: проверка «можно ли начать» и запись операции
      // не перемежаются с другой операцией над тем же платежом.
      const [row]: PaymentRow[] = await manager.query(
        `SELECT * FROM payments WHERE order_id = $1
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [orderId],
      );
      if (!row) return { payment: null, transaction: null };

      const payment = toPayment(row);
      const planned = plan(payment);
      if (!planned) return { payment, transaction: null };

      const transaction = await this.insertTransaction(manager, payment.id, {
        type: planned.type,
        amount: planned.amount,
        idempotencyKey,
        correlationId,
      });
      return { payment, transaction };
    });
  }

  finish(
    transactionId: string,
    complete: Parameters<PaymentRepository["finish"]>[1],
  ): Promise<TransactionRecord> {
    return this.dataSource.transaction(async (manager) => {
      const [current]: TransactionRow[] = await manager.query(
        `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`,
        [transactionId],
      );
      // Итог уже зафиксировал одновременный повтор — он и возвращается.
      if (current.status !== "PENDING") return toTransaction(current);

      const [row]: PaymentRow[] = await manager.query(
        `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
        [current.payment_id],
      );
      const payment = toPayment(row);
      const result = complete(payment, toTransaction(current));

      await this.savePayment(manager, payment, row.version);
      const [finished] = updatedRows<TransactionRow>(
        await manager.query(
          `UPDATE payment_transactions
            SET status = $2, response = $3, provider_ref = $4, error_code = $5, finished_at = now()
          WHERE id = $1
          RETURNING *`,
          [
            transactionId,
            result.status,
            JSON.stringify(result.outcome),
            result.providerRef ?? null,
            result.errorCode ?? null,
          ],
        ),
      );
      await this.enqueue(manager, result, row.order_id);
      return toTransaction(finished);
    });
  }

  async openOperations(orderId: string) {
    const [row]: PaymentRow[] = await this.dataSource.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    if (!row) return null;
    const transactions: TransactionRow[] = await this.dataSource.query(
      `SELECT * FROM payment_transactions
        WHERE payment_id = $1 AND status = 'PENDING'
        ORDER BY created_at`,
      [row.id],
    );
    return { payment: toPayment(row), transactions: transactions.map(toTransaction) };
  }

  async pending(
    olderThanMs: number,
    youngerThanMs: number,
    limit: number,
  ): Promise<StartedOperation[]> {
    const rows: Array<TransactionRow & { payment: PaymentRow }> = await this.dataSource.query(
      `SELECT t.*, to_jsonb(p) AS payment
         FROM payment_transactions t
         JOIN payments p ON p.id = t.payment_id
        WHERE t.status = 'PENDING'
          AND t.created_at <= now() - make_interval(secs => $1::double precision / 1000)
          AND t.created_at >= now() - make_interval(secs => $2::double precision / 1000)
        ORDER BY t.created_at
        LIMIT $3`,
      [olderThanMs, youngerThanMs, limit],
    );
    return rows.map((row) => ({
      payment: toPayment(reviveDates(row.payment)),
      transaction: toTransaction(row),
    }));
  }

  async history(orderId: string): Promise<PaymentHistory> {
    const payments: PaymentRow[] = await this.dataSource.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );
    const transactions: TransactionRow[] = await this.dataSource.query(
      `SELECT t.* FROM payment_transactions t
         JOIN payments p ON p.id = t.payment_id
        WHERE p.order_id = $1
        ORDER BY t.created_at`,
      [orderId],
    );
    return {
      payments: payments.map((row) => ({ ...toPayment(row).snapshot })),
      transactions: transactions.map(toTransaction),
    };
  }

  private async byKey(manager: EntityManager, key: string): Promise<StartedOperation | null> {
    const [row]: Array<TransactionRow & { payment: PaymentRow }> = await manager.query(
      `SELECT t.*, to_jsonb(p) AS payment
         FROM payment_transactions t
         JOIN payments p ON p.id = t.payment_id
        WHERE t.idempotency_key = $1`,
      [key],
    );
    return row
      ? { payment: toPayment(reviveDates(row.payment)), transaction: toTransaction(row) }
      : null;
  }

  private async insertTransaction(
    manager: EntityManager,
    paymentId: string,
    input: {
      type: TransactionRecord["type"];
      amount: number;
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<TransactionRecord> {
    const [row]: TransactionRow[] = await manager.query(
      `INSERT INTO payment_transactions (payment_id, type, amount, idempotency_key, request)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        paymentId,
        input.type,
        input.amount,
        input.idempotencyKey,
        JSON.stringify({ amount: input.amount, correlationId: input.correlationId }),
      ],
    );
    if (row) return toTransaction(row);

    const [raced]: TransactionRow[] = await manager.query(
      `SELECT * FROM payment_transactions WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return toTransaction(raced);
  }

  /** Оптимистичная проверка версии — страховка поверх блокировки строки. */
  private async savePayment(manager: EntityManager, payment: Payment, version: number) {
    const state = payment.snapshot;
    const updated = updatedRows(
      await manager.query(
        `UPDATE payments
          SET status = $2, refunded_amount = $3, provider_payment_id = $4,
              authorized_at = $5, captured_at = $6, updated_at = now(), version = version + 1
        WHERE id = $1 AND version = $7
        RETURNING id`,
        [
          state.id,
          state.status,
          state.refundedAmount,
          state.providerPaymentId,
          state.authorizedAt,
          state.capturedAt,
          version,
        ],
      ),
    );
    if (updated.length === 0) {
      throw new ConflictError("платёж изменён другой операцией — повторите", {
        paymentId: state.id,
      });
    }
  }

  /** Событие пишется той же транзакцией, что и изменение платежа (REL-3). */
  private async enqueue(manager: EntityManager, result: Completion, orderId: string) {
    for (const event of result.events as DomainEvent[]) {
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
            // События одного заказа — в одну партицию, по порядку.
            partitionKey: orderId,
            correlationId: event.correlationId,
            ...(event.causationId ? { causationId: event.causationId } : {}),
            // Контекст трассы — отправка из outbox продолжит эту трассу (OBS-2)
            ...traceHeaders(),
          }),
        ],
      );
    }
  }
}

/**
 * Для `UPDATE … RETURNING` драйвер возвращает пару `[строки, число строк]`,
 * а для `SELECT` и `INSERT … RETURNING` — сами строки.
 */
function updatedRows<T = unknown>(result: unknown): T[] {
  const value = result as unknown[];
  return Array.isArray(value[0]) ? (value[0] as T[]) : (value as T[]);
}

function toPayment(row: PaymentRow): Payment {
  return Payment.restore({
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    amount: Number(row.amount),
    refundedAmount: Number(row.refunded_amount),
    status: row.status,
    providerPaymentId: row.provider_payment_id,
    authorizedAt: row.authorized_at,
    capturedAt: row.captured_at,
    version: Number(row.version),
  });
}

function toTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    paymentId: row.payment_id,
    type: row.type,
    amount: Number(row.amount),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    request: row.request ?? { amount: Number(row.amount), correlationId: "" },
    outcome: row.response,
    providerRef: row.provider_ref,
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Строка платежа, пришедшая через `to_jsonb`, — даты в ней строками. */
function reviveDates(row: PaymentRow): PaymentRow {
  const date = (value: unknown) => (value ? new Date(value as string) : null);
  return { ...row, authorized_at: date(row.authorized_at), captured_at: date(row.captured_at) };
}
