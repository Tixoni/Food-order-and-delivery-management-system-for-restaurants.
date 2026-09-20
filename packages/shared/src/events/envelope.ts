import { randomUUID } from "node:crypto";

/**
 * Конверт доменного события.
 *
 * Единая оболочка для всех сообщений между сервисами. Без неё не работают
 * ни защита от повторной обработки, ни сквозная трассировка:
 *
 *   messageId     — первичный ключ в таблице обработанных сообщений (REL-4)
 *   correlationId — сквозной идентификатор действия пользователя (OBS-1, OBS-2)
 *   causationId   — идентификатор сообщения-причины, восстанавливает цепочку
 *   eventVersion  — позволяет менять схему события, не ломая потребителей
 *
 * См. заметку «11 — Контракты API и события».
 */
export interface DomainEvent<TPayload = unknown> {
  readonly messageId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: TPayload;
}

export interface CreateEventInput<TPayload> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId: string;
  causationId?: string;
  eventVersion?: number;
  occurredAt?: Date;
}

const NON_EMPTY = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Ошибка формата события. Не наследуется от AppError: пакет событий не зависит от слоя ошибок. */
export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export function createEvent<TPayload>(input: CreateEventInput<TPayload>): DomainEvent<TPayload> {
  if (!NON_EMPTY(input.eventType)) {
    throw new InvalidEventError("eventType обязателен");
  }
  if (!NON_EMPTY(input.aggregateType)) {
    throw new InvalidEventError("aggregateType обязателен");
  }
  if (!NON_EMPTY(input.aggregateId)) {
    throw new InvalidEventError("aggregateId обязателен");
  }
  if (!NON_EMPTY(input.correlationId)) {
    throw new InvalidEventError("correlationId обязателен: без него теряется трассировка");
  }

  const event: DomainEvent<TPayload> = {
    messageId: randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    correlationId: input.correlationId,
    payload: input.payload,
  };

  return input.causationId ? { ...event, causationId: input.causationId } : event;
}

/**
 * Разбор события, пришедшего из брокера.
 *
 * Потребитель обязан быть терпимым к неизвестным полям: отправитель может
 * добавить новое поле, и это не должно ломать приём. Поэтому проверяются
 * только обязательные поля, а лишние сохраняются как есть.
 */
export function parseEvent<TPayload = unknown>(raw: unknown): DomainEvent<TPayload> {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidEventError("событие должно быть объектом");
  }

  const candidate = raw as Record<string, unknown>;
  const required = [
    "messageId",
    "eventType",
    "aggregateType",
    "aggregateId",
    "occurredAt",
    "correlationId",
  ];

  for (const field of required) {
    if (!NON_EMPTY(candidate[field])) {
      throw new InvalidEventError(`поле ${field} отсутствует или пусто`);
    }
  }

  if (typeof candidate.eventVersion !== "number") {
    throw new InvalidEventError("поле eventVersion должно быть числом");
  }

  return candidate as unknown as DomainEvent<TPayload>;
}

/** Событие-следствие: наследует корреляцию и ссылается на причину. */
export function deriveEvent<TPayload>(
  cause: DomainEvent,
  input: Omit<CreateEventInput<TPayload>, "correlationId" | "causationId">,
): DomainEvent<TPayload> {
  return createEvent({
    ...input,
    correlationId: cause.correlationId,
    causationId: cause.messageId,
  });
}
