import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

/**
 * Таблица исходящих сообщений (Transactional Outbox, REL-3).
 *
 * Событие записывается сюда той же транзакцией, что и изменение данных,
 * а отправкой в брокер занимается отдельный процесс. Без этой таблицы
 * остаётся выбор из двух плохих вариантов: отправить до фиксации
 * транзакции — и разослать событие об изменении, которого не случилось;
 * отправить после — и потерять событие при сбое между фиксацией
 * и отправкой.
 *
 * Таблица создаётся общей миграцией `infra/migrations/common/001_messaging.sql`
 * во всех базах: публикуют события все сервисы.
 */
@Entity("outbox_messages")
export class OutboxMessageOrmEntity {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id!: string;

  @Column("text", { name: "aggregate_type" })
  aggregateType!: string;

  @Column("uuid", { name: "aggregate_id" })
  aggregateId!: string;

  @Column("text", { name: "event_type" })
  eventType!: string;

  @Column("integer", { name: "event_version", default: 1 })
  eventVersion!: number;

  /**
   * Полный конверт события: то, что уйдёт в брокер без изменений.
   * Тип намеренно широкий — таблица общая для всех событий сервиса.
   */
  @Column("jsonb")
  payload!: object;

  /** Служебные поля отправки: ключ партиции, сквозной идентификатор. */
  @Column("jsonb", { default: () => "'{}'::jsonb" })
  headers!: Record<string, string>;

  @Column("timestamptz", { name: "created_at", default: () => "now()" })
  createdAt!: Date;

  /** Пока null — сообщение ждёт отправки. По этому условию построен индекс. */
  @Column("timestamptz", { name: "published_at", nullable: true })
  publishedAt!: Date | null;

  @Column("integer", { default: 0 })
  attempts!: number;

  @Column("text", { name: "last_error", nullable: true })
  lastError!: string | null;
}
