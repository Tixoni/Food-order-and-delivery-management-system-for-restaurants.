import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  TimeoutError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  getCorrelationId,
  type AppError,
  type ErrorCode,
  type Logger,
} from "@food-delivery/shared";
import { CORRELATION_HEADER } from "../correlation.middleware";
import { CircuitBreaker, CircuitOpenError, type CircuitState } from "../resilience/circuit-breaker";
import { retry } from "../resilience/retry";

export interface InternalHttpClientOptions {
  /** Имя сервиса-получателя: в ошибках, журнале и метриках. */
  name: string;
  baseUrl: string;
  /** Таймаут одной попытки. Без него зависший сосед держит вызывающего бесконечно. */
  timeoutMs: number;
  /** Повторы. Применяются только к идемпотентным вызовам. */
  retry?: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  /** Размыкатель цепи; `false` — выключен. */
  breaker?: { failureThreshold: number; openDurationMs: number } | false;
  logger?: Logger;
  onCircuitChange?: (state: CircuitState, name: string) => void;
  /** Подменяется в тестах. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface InternalRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Токен пользователя передаётся дальше без изменений: права проверяет владелец данных. */
  token?: string;
  body?: unknown;
  /**
   * Можно ли повторять вызов. Чтение идемпотентно всегда; изменяющий вызов —
   * только если несёт ключ идемпотентности, по которому получатель узнаёт повтор.
   */
  idempotent?: boolean;
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const DEFAULT_BREAKER = { failureThreshold: 5, openDurationMs: 10_000 };

/**
 * Синхронный вызов соседнего сервиса по внутреннему HTTP.
 *
 * Собирает в одном месте то, без чего синхронный вызов опасен:
 *
 *   таймаут      — медленный сосед не держит вызывающего бесконечно;
 *   повторы      — кратковременный сбой сети не превращается в ошибку
 *                  пользователя; только для идемпотентных вызовов;
 *   размыкатель  — отказавший сосед не получает лавину запросов, а
 *                  вызывающий получает отказ сразу, а не после таймаута;
 *   сквозной идентификатор и токен — передаются дальше (OBS-1, SEC-2);
 *   формат ошибок — ответ соседа «не найдено» остаётся «не найдено»,
 *                  а не превращается во «внутреннюю ошибку».
 */
export class InternalHttpClient {
  private readonly breaker: CircuitBreaker | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InternalHttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.breaker =
      options.breaker === false
        ? null
        : new CircuitBreaker({
            name: options.name,
            ...DEFAULT_BREAKER,
            ...options.breaker,
            onStateChange: (state, name) => {
              options.logger?.warn("состояние размыкателя изменилось", { dependency: name, state });
              options.onCircuitChange?.(state, name);
            },
          });
  }

  get circuitState(): CircuitState {
    return this.breaker?.currentState ?? "closed";
  }

  async request<T>(request: InternalRequest): Promise<T> {
    const idempotent = request.idempotent ?? request.method === "GET";
    const once = () => this.throughBreaker(() => this.send<T>(request));

    if (!idempotent) return once();

    const settings = { ...DEFAULT_RETRY, ...this.options.retry };
    return retry(once, {
      ...settings,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      // Разомкнутую цепь сразу не повторяем: она разомкнута на известное
      // время, и повтор через сотню миллисекунд ответит тем же.
      retryOn: (error) => isDependencyFailure(error) && !(error instanceof CircuitOpenError),
      onRetry: (error, attempt, delayMs) =>
        this.options.logger?.debug("повтор вызова", {
          dependency: this.options.name,
          path: request.path,
          attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  private throughBreaker<T>(call: () => Promise<T>): Promise<T> {
    return this.breaker ? this.breaker.execute(call, isDependencyFailure) : call();
  }

  private async send<T>(request: InternalRequest): Promise<T> {
    const { method, path, token, body } = request;
    const started = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          [CORRELATION_HEADER]: getCorrelationId(),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      this.options.logger?.warn("сервис не ответил", {
        dependency: this.options.name,
        method,
        path,
        timedOut,
      });
      throw timedOut
        ? new TimeoutError(`${this.options.name} не ответил вовремя`, { path })
        : new ExternalServiceError(`${this.options.name} недоступен`, { path });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) throw appErrorFromResponse(this.options.name, payload, response.status, path);

    this.options.logger?.debug("ответ сервиса", {
      dependency: this.options.name,
      method,
      path,
      ms: Date.now() - started,
    });
    return payload as T;
  }
}

/** Отказ зависимости, а не штатный ответ работающего сервиса. */
export function isDependencyFailure(error: unknown): boolean {
  return error instanceof ExternalServiceError || error instanceof TimeoutError;
}

interface ErrorBody {
  code?: ErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

/** Ответы соседа о действиях пользователя — передаются с тем же смыслом. */
const BY_CODE: Partial<
  Record<ErrorCode, new (m: string, d?: Record<string, unknown>) => AppError>
> = {
  VALIDATION_FAILED: ValidationError,
  UNAUTHORIZED: UnauthorizedError,
  FORBIDDEN: ForbiddenError,
  NOT_FOUND: NotFoundError,
  CONFLICT: ConflictError,
  DOMAIN_RULE_VIOLATED: DomainRuleError,
  RATE_LIMITED: TooManyRequestsError,
};

/**
 * Ошибка соседнего сервиса — снова ошибка приложения, с тем же смыслом.
 * Всё, что пришло кодом 5xx или незнакомым кодом, считается отказом
 * зависимости: такой вызов имеет смысл повторить.
 */
export function appErrorFromResponse(
  dependency: string,
  payload: unknown,
  status: number,
  path: string,
): AppError {
  const body = (payload ?? {}) as ErrorBody;
  const message = body.message ?? `${dependency} ответил ошибкой`;
  const Specific = status < 500 && body.code ? BY_CODE[body.code] : undefined;

  return Specific
    ? new Specific(message, { ...body.details, path })
    : new ExternalServiceError(message, { ...body.details, path, status });
}
