import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Контекст запроса, невидимо сопровождающий всю обработку.
 *
 * Задача: не передавать correlationId параметром через каждую функцию.
 * Идентификатор создаётся на шлюзе при первом обращении и дальше доступен
 * из любого места — включая обработчики событий, — не загрязняя сигнатуры.
 *
 * Требования OBS-1 и OBS-2: все записи журнала и все участки трассировки
 * одного действия пользователя должны находиться одним запросом.
 */
export interface RequestContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly userId?: string;
  readonly source?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/** Выполняет функцию внутри заданного контекста. Вложенные вызовы контекст наследуют. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Идентификатор текущего действия. Если контекста нет — создаётся новый,
 * чтобы запись в журнале никогда не осталась без привязки.
 */
export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}
