import { isSpanContextValid, trace } from "@opentelemetry/api";
import { getContext } from "./context";

/**
 * Структурированный журнал.
 *
 * Пишет строки JSON, а не свободный текст: иначе записи от четырёх сервисов
 * невозможно собрать и отфильтровать. Идентификатор действия подставляется
 * сам из контекста запроса (OBS-1).
 *
 * Значения чувствительных полей заменяются заглушкой — требования SEC-3
 * (данные карт не попадают в журнал) и SEC-4 (обезличивание персональных данных).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Поля, значения которых не должны попадать в журнал ни при каких условиях. */
const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "apikey",
  "cardnumber",
  "pan",
  "cvv",
  "cvc",
  "expiry",
  "phone",
  "email",
  // Адрес доставки — персональные данные (SEC-4): dropoffAddress, addressText…
  "address",
];

const MASK = "***";
const MAX_DEPTH = 6;

function isSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEYS.some((s) => normalized.includes(s));
}

export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[глубина превышена]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitive(key) ? MASK : maskSensitive(item, depth + 1);
  }
  return result;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Куда писать. По умолчанию — стандартный вывод; в тестах подменяется. */
  sink?: (line: string) => void;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  correlationId?: string;
  userId?: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly service: string;
  private readonly minLevel: number;
  private readonly sink: (line: string) => void;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions, bindings: Record<string, unknown> = {}) {
    this.service = options.service;
    this.minLevel = LEVEL_ORDER[options.level ?? "info"];
    this.sink = options.sink ?? ((line) => process.stdout.write(line + "\n"));
    this.bindings = bindings;
  }

  /** Дочерний журнал с постоянными полями: например, идентификатором заказа. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(
      {
        service: this.service,
        level: this.levelName(),
        sink: this.sink,
      },
      { ...this.bindings, ...bindings },
    );
  }

  debug = (message: string, fields?: Record<string, unknown>) =>
    this.write("debug", message, fields);
  info = (message: string, fields?: Record<string, unknown>) => this.write("info", message, fields);
  warn = (message: string, fields?: Record<string, unknown>) => this.write("warn", message, fields);

  error(message: string, error?: unknown, fields?: Record<string, unknown>) {
    const details =
      error instanceof Error
        ? { errorName: error.name, errorMessage: error.message, stack: error.stack }
        : error !== undefined
          ? { error: String(error) }
          : {};
    this.write("error", message, { ...details, ...fields });
  }

  private levelName(): LogLevel {
    return (Object.keys(LEVEL_ORDER) as LogLevel[]).find(
      (k) => LEVEL_ORDER[k] === this.minLevel,
    ) as LogLevel;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const context = getContext();
    // Номер трассы (OBS-2): из записи журнала — переход к трассе в Jaeger.
    // Без включённой трассировки участка нет, и поле не пишется.
    const span = trace.getActiveSpan()?.spanContext();
    const traceId = span && isSpanContextValid(span) ? span.traceId : undefined;
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context?.userId ? { userId: context.userId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(maskSensitive(this.bindings) as Record<string, unknown>),
      ...(fields ? (maskSensitive(fields) as Record<string, unknown>) : {}),
    };

    this.sink(JSON.stringify(record));
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}
