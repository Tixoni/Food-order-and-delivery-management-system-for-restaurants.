import type { EntityManager } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import { OutboxMessageOrmEntity } from "./outbox.orm-entity";

/**
 * Запись событий в таблицу исходящих сообщений.
 *
 * Принимает EntityManager, а не репозиторий, именно для того, чтобы вызов
 * происходил внутри чужой транзакции: событие и изменение данных должны
 * попасть в базу вместе или не попасть вовсе (REL-3).
 */
export async function writeOutbox(
  manager: EntityManager,
  events: readonly DomainEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map((event) => ({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    // В брокер уходит конверт целиком: потребителю нужны и messageId
    // для защиты от повторов, и correlationId для трассировки.
    payload: event,
    headers: partitionHeaders(event),
  }));

  await manager.getRepository(OutboxMessageOrmEntity).insert(rows);
}

/**
 * Ключ партиции. Для событий каталога это ресторан, а не блюдо:
 * так все изменения одного меню обрабатываются потребителем по порядку.
 * Если бы ключом было блюдо, «вернули в продажу» могло бы обогнать
 * «убрали из продажи», и кэш остался бы с неверным состоянием
 * (см. заметку «11 — Контракты API и события»).
 */
function partitionHeaders(event: DomainEvent): Record<string, string> {
  const payload = event.payload as { restaurantId?: string } | undefined;

  return {
    partitionKey: payload?.restaurantId ?? event.aggregateId,
    correlationId: event.correlationId,
    ...(event.causationId ? { causationId: event.causationId } : {}),
  };
}
