import { isRetryable } from "@food-delivery/shared";

export interface RetryOptions {
  /** Всего попыток, включая первую. */
  attempts: number;
  /** Задержка перед второй попыткой; дальше удваивается. */
  baseDelayMs: number;
  /** Потолок задержки: без него десятая попытка ждала бы минуты. */
  maxDelayMs: number;
  /** Какие ошибки имеет смысл повторять. По умолчанию — помеченные как повторяемые. */
  retryOn?: (error: unknown) => boolean;
  /** Вызывается перед каждой повторной попыткой — для журнала. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Ожидание; подменяется в тестах. */
  sleep?: (ms: number) => Promise<void>;
  /** Источник случайности для разброса; подменяется в тестах. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Задержка перед попыткой номер `attempt` (считая с первой повторной).
 *
 * Экспоненциальный рост со случайным разбросом («full jitter»): без разброса
 * все клиенты, получившие отказ одновременно, повторяют тоже одновременно —
 * и только что поднявшийся сервис снова ложится под той же волной.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Повтор вызова с экспоненциальной задержкой.
 *
 * Повторяются только ошибки, у которых повтор осмыслен: отказ сети, таймаут,
 * ответ 5xx. «Не найдено» или «нарушено правило» повторять бессмысленно —
 * ответ не изменится, а время уйдёт.
 *
 * Важно: повторять можно только идемпотентные операции. Чтение идемпотентно
 * само по себе; изменяющий вызов — только если несёт ключ идемпотентности,
 * по которому получатель узнаёт повтор (PAY-4, ORD-4).
 */
export async function retry<T>(call: (attempt: number) => Promise<T>, options: RetryOptions) {
  const retryOn = options.retryOn ?? isRetryable;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !retryOn(error)) throw error;
      const delay = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
