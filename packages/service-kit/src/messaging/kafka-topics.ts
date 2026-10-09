import type { Kafka } from "kafkajs";

/** Сколько партиций у каждого топика: столько потребителей одной группы работают параллельно. */
export const DEFAULT_PARTITIONS = 3;

/**
 * Явное создание топиков.
 *
 * Брокер настроен не создавать топики сам: опечатка в имени должна быть
 * ошибкой, а не тихим появлением нового топика, в который никто не пишет.
 * Поэтому нужные топики создаются явно — первым, кому они понадобились.
 * Повторное создание существующего топика ничего не меняет.
 *
 * Коэффициент репликации 1 — ограничение прототипа с одним брокером.
 * В целевой схеме брокеров три и коэффициент 3: отказ узла не теряет
 * ни одного сообщения (см. заметку «21 — Оркестрация и целевая инфраструктура»).
 */
export async function ensureTopics(
  kafka: Kafka,
  topics: readonly string[],
  partitions = DEFAULT_PARTITIONS,
  replicationFactor = 1,
): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: topics.map((topic) => ({ topic, numPartitions: partitions, replicationFactor })),
    });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

/** Ошибка в одну строку для журнала и заголовков сообщения. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
