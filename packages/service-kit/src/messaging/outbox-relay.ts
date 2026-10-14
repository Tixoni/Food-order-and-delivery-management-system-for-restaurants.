import { Kafka, type Producer } from "kafkajs";
import type { Logger } from "@food-delivery/shared";
import { SpanKind, startStoredSpan } from "../trace-context";
import { ensureTopics, errorText } from "./kafka-topics";

/** Выполнение SQL. Каркас не знает про ORM сервиса: ему достаточно запроса. */
export type SqlQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

/** Выполнение работы в одной транзакции базы сервиса. */
export type SqlTransaction = <T>(work: (query: SqlQuery) => Promise<T>) => Promise<T>;

export interface OutboxRelayOptions {
  /** Топик, куда уходят события сервиса. Имя — только из packages/contracts. */
  topic: string;
  kafka: { brokers: string[]; clientId: string };
  pollIntervalMs: number;
  batchSize: number;
  transaction: SqlTransaction;
  logger: Logger;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  headers: Record<string, string> | null;
}

/**
 * Отправка накопленных событий в брокер — вторая половина Transactional Outbox.
 *
 * Работает отдельно от обработки запросов: запрос завершается, как только
 * событие записано в базу той же транзакцией, что и изменение данных,
 * и не ждёт брокера. Если брокер лежит, сервис продолжает работать,
 * а события копятся в таблице и уходят после восстановления (REL-3).
 *
 * Гарантия — «хотя бы один раз»: если отправка удалась, а отметка
 * о публикации не сохранилась, сообщение уйдёт повторно. Потерять событие
 * хуже, чем продублировать; от дублей защищается потребитель (REL-4).
 * Сам отправитель включён в идемпотентном режиме: повтор отправки внутри
 * одного соединения брокер отсекает сам.
 *
 * Выборка идёт с `FOR UPDATE SKIP LOCKED`: при двух и более репликах
 * сервиса (SCAL-2) одно и то же сообщение не будет взято дважды.
 *
 * Один класс на все сервисы: исправление здесь распространяется на всех
 * сразу, а не копируется по пяти местам с расхождениями.
 */
export class OutboxRelay {
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private topicPrepared = false;
  private nextTopicAttemptAt = 0;

  constructor(private readonly options: OutboxRelayOptions) {
    this.kafka = new Kafka({
      clientId: options.kafka.clientId,
      brokers: options.kafka.brokers,
      // Немного попыток с нарастающей задержкой: недоступность брокера —
      // ожидаемое состояние, а не повод заваливать журнал ошибками.
      retry: { initialRetryTime: 300, retries: 3 },
      logCreator: () => () => {},
    });
  }

  async start(): Promise<void> {
    await this.ensureTopic();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs);
    // Таймер не должен удерживать процесс при завершении работы.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.producer?.disconnect().catch(() => undefined);
    this.producer = null;
  }

  /**
   * Один проход: взять неотправленные сообщения, отправить, отметить.
   * Пропускается, если предыдущий проход ещё не закончился, — иначе
   * при медленном брокере проходы наложатся друг на друга.
   */
  async tick(): Promise<number> {
    if (this.busy || this.stopped) return 0;
    this.busy = true;

    try {
      // Если брокер был недоступен при старте, подготовка топика
      // повторяется: одной попытки при запуске недостаточно для REL-3.
      if (!this.topicPrepared) await this.ensureTopic();
      if (!this.topicPrepared) return 0;
      const result = await this.publishBatch();
      if (result.error !== undefined) throw result.error;
      return result.published;
    } catch (error) {
      this.options.logger.warn("не удалось отправить события в брокер", {
        topic: this.options.topic,
        error: errorText(error),
      });
      return 0;
    } finally {
      this.busy = false;
    }
  }

  private publishBatch(): Promise<{ published: number; error?: unknown }> {
    return this.options.transaction(async (query) => {
      const rows = (await query(
        `SELECT id, aggregate_id, event_type, payload, headers
           FROM outbox_messages
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize],
      )) as OutboxRow[];

      if (rows.length === 0) return { published: 0 };
      const ids = rows.map((row) => row.id);

      // Трасса (OBS-2): событие записано в запросе, а уходит сейчас, в фоне,
      // пачкой из разных трасс. У каждого сообщения — свой участок отправки,
      // продолжающий трассу из его строки outbox; его traceparent уходит
      // в заголовках сообщения, и потребитель продолжит ту же трассу.
      const spans = rows.map((row) =>
        startStoredSpan({
          carrier: row.headers,
          name: `${this.options.topic} publish`,
          kind: SpanKind.PRODUCER,
          attributes: {
            "messaging.system": "kafka",
            "messaging.destination.name": this.options.topic,
            "messaging.operation.type": "send",
            "event.type": row.event_type,
          },
        }),
      );
      try {
        const producer = await this.connect();
        await producer.send({
          topic: this.options.topic,
          messages: rows.map((row, index) => ({
            // Ключ партиции задаёт порядок обработки: все события одного
            // агрегата попадают в одну партицию и читаются по порядку.
            key: row.headers?.partitionKey ?? row.aggregate_id,
            value: JSON.stringify(row.payload),
            headers: { ...(row.headers ?? {}), ...spans[index].headers },
          })),
        });
        for (const span of spans) span.end();
      } catch (error) {
        for (const span of spans) span.end(error);
        // Число попыток и последняя ошибка остаются в таблице: по ним видно,
        // какие события застряли и почему, без чтения журналов. Ошибка
        // возвращается, а не бросается: иначе откатилась бы и эта запись.
        await query(
          `UPDATE outbox_messages SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])`,
          [ids, errorText(error).slice(0, 1000)],
        );
        await this.producer?.disconnect().catch(() => undefined);
        this.producer = null;
        return { published: 0, error };
      }

      await query(`UPDATE outbox_messages SET published_at = now() WHERE id = ANY($1::bigint[])`, [
        ids,
      ]);

      this.options.logger.debug("события отправлены", {
        topic: this.options.topic,
        count: rows.length,
        types: [...new Set(rows.map((row) => row.event_type))],
      });
      return { published: rows.length };
    });
  }

  private async connect(): Promise<Producer> {
    if (this.producer) return this.producer;

    const producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      // Идемпотентный режим: брокер отбрасывает дубль, возникший из-за
      // повторной отправки после потери подтверждения. Требует не больше
      // одного неподтверждённого запроса — заодно сохраняет порядок.
      idempotent: true,
      maxInFlightRequests: 1,
    });
    await producer.connect();
    this.producer = producer;
    return producer;
  }

  private async ensureTopic(): Promise<void> {
    if (this.topicPrepared || Date.now() < this.nextTopicAttemptAt) return;
    this.nextTopicAttemptAt = Date.now() + 5000;
    try {
      await ensureTopics(this.kafka, [this.options.topic]);
      this.topicPrepared = true;
    } catch (error) {
      // Недоступность брокера при запуске не должна мешать сервису
      // принимать запросы: события уйдут позже.
      this.options.logger.warn("топик событий не подготовлен", {
        topic: this.options.topic,
        error: errorText(error),
      });
    }
  }
}
