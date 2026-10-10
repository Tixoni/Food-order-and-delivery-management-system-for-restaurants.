/**
 * Создано по образцу сервиса catalog.
 *
 * Настройки читаются из переменных окружения — ни одного секрета в коде.
 * Проверка выполняется при запуске: лучше не стартовать вовсе, чем работать
 * с неверной настройкой и обнаружить это на первом запросе.
 */
export interface ServiceConfig {
  port: number;
  nodeEnv: string;
  logLevel: "debug" | "info" | "warn" | "error";
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  kafka: { brokers: string[]; clientId: string };
  outbox: { pollIntervalMs: number; batchSize: number };
  /**
   * Служебный токен внутреннего API: операции с деньгами выполняет только
   * тот, кто его знает (`order`). Отдельный ключ доступа денежного контура.
   */
  internalToken: string;
  provider: {
    url: string;
    shopId: string;
    secretKey: string;
    /**
     * Таймаут одной попытки. Вместе с повторами укладывается в таймаут
     * вызывающего (`order` ждёт 2 с): иначе он повторит запрос раньше,
     * чем платёжный сервис закончит первый.
     */
    timeoutMs: number;
    retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
    breaker: { failureThreshold: number; openDurationMs: number };
  };
  /** Сверка незавершённых операций после сбоев. */
  reconcile: {
    intervalMs: number;
    /** Моложе этого — операция, скорее всего, ещё выполняется. */
    afterMs: number;
    /** Старше этого — нужна ручная сверка, автоматически не трогается. */
    windowMs: number;
    batchSize: number;
  };
}

/** Метка для внедрения настроек: интерфейса во время выполнения не существует. */
export const PAYMENT_CONFIG = Symbol("PaymentConfig");

export type PaymentConfig = ServiceConfig;

/** Учебные значения по умолчанию; в рабочем окружении запрещены. */
const DEV_INTERNAL_TOKEN = "payment-internal-dev-token";
const DEV_PROVIDER_SECRET = "test_provider_dev_secret";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`не задана обязательная переменная окружения ${name}`);
  }
  return value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`переменная окружения ${name} должна быть целым положительным числом`);
  }
  return value;
}

export function loadConfig(): ServiceConfig {
  const level = process.env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error(`недопустимое значение LOG_LEVEL: ${level}`);
  }
  const nodeEnv = process.env.NODE_ENV ?? "development";

  const internalToken = required("PAYMENT_INTERNAL_TOKEN", DEV_INTERNAL_TOKEN);
  const secretKey = required("PROVIDER_SECRET_KEY", DEV_PROVIDER_SECRET);
  // Учебный секрет в рабочем окружении — то же, что секрет в коде.
  if (nodeEnv === "production" && process.env.ALLOW_DEV_SECRETS !== "true") {
    if (internalToken === DEV_INTERNAL_TOKEN || secretKey === DEV_PROVIDER_SECRET) {
      throw new Error(
        "в production нужны собственные PAYMENT_INTERNAL_TOKEN и PROVIDER_SECRET_KEY " +
          "(для учебного стенда — ALLOW_DEV_SECRETS=true)",
      );
    }
  }

  return {
    port: numeric("PAYMENT_PORT", 3003),
    nodeEnv,
    logLevel: level as ServiceConfig["logLevel"],
    database: {
      host: required("POSTGRES_HOST", "localhost"),
      port: numeric("POSTGRES_PORT", 15432),
      username: required("POSTGRES_USER", "app"),
      password: required("POSTGRES_PASSWORD", "app"),
      database: required("PAYMENT_DB", "payment_db"),
    },
    kafka: {
      brokers: required("KAFKA_BROKERS", "localhost:19092")
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: process.env.KAFKA_CLIENT_ID ?? "payment",
    },
    outbox: {
      pollIntervalMs: numeric("OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: numeric("OUTBOX_BATCH_SIZE", 100),
    },
    internalToken,
    provider: {
      url: required("PROVIDER_URL", "http://localhost:13010"),
      shopId: required("PROVIDER_SHOP_ID", "food-delivery-shop"),
      secretKey,
      timeoutMs: numeric("PROVIDER_TIMEOUT_MS", 800),
      retry: {
        attempts: numeric("PROVIDER_RETRY_ATTEMPTS", 2),
        baseDelayMs: numeric("PROVIDER_RETRY_BASE_MS", 100),
        maxDelayMs: numeric("PROVIDER_RETRY_MAX_MS", 300),
      },
      breaker: {
        failureThreshold: numeric("CIRCUIT_FAILURE_THRESHOLD", 5),
        openDurationMs: numeric("CIRCUIT_OPEN_MS", 10_000),
      },
    },
    reconcile: {
      intervalMs: numeric("RECONCILE_INTERVAL_MS", 10_000),
      afterMs: numeric("RECONCILE_AFTER_MS", 30_000),
      windowMs: numeric("RECONCILE_WINDOW_MS", 60 * 60 * 1000),
      batchSize: numeric("RECONCILE_BATCH_SIZE", 20),
    },
  };
}
