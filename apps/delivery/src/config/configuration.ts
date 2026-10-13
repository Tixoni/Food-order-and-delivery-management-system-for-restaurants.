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
  redis: { host: string; port: number };
  kafka: { brokers: string[]; clientId: string };
  outbox: { pollIntervalMs: number; batchSize: number };
  auth: { issuer: string; providerUrl?: string; audience: string; disabled: boolean };
  /** Служебный токен внутреннего API: запрос и освобождение курьера — только от `order`. */
  internalToken: string;
  dispatch: {
    radiusMeters: number;
    offerTtlSeconds: number;
    freshSeconds: number;
    /** Как часто фоновый процесс ищет просроченные предложения. */
    sweepIntervalMs: number;
  };
  /**
   * Маршрутизатор OSRM (DLV-6). Необязателен: `url` = null — подбор и
   * прогноз по прямой (REL-2).
   */
  routing: { url: string | null; timeoutMs: number };
  locations: {
    /** Сколько живёт актуальная позиция в кэше без обновлений. */
    positionTtlSeconds: number;
    /** Пакетная запись истории: раз в столько миллисекунд. */
    flushIntervalMs: number;
    /** Предел буфера: при недоступной базе история не съедает память. */
    maxBuffer: number;
  };
}

export const DELIVERY_CONFIG = Symbol("DeliveryConfig");

export type DeliveryConfig = ServiceConfig;

const DEV_INTERNAL_TOKEN = "delivery-internal-dev-token";

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
  if (nodeEnv === "production" && process.env.AUTH_DISABLED === "true") {
    throw new Error("AUTH_DISABLED запрещён в production");
  }
  const internalToken = required("DELIVERY_INTERNAL_TOKEN", DEV_INTERNAL_TOKEN);
  if (
    nodeEnv === "production" &&
    internalToken === DEV_INTERNAL_TOKEN &&
    process.env.ALLOW_DEV_SECRETS !== "true"
  ) {
    throw new Error(
      "в production нужен собственный DELIVERY_INTERNAL_TOKEN (для учебного стенда — ALLOW_DEV_SECRETS=true)",
    );
  }

  return {
    port: numeric("DELIVERY_PORT", 3004),
    nodeEnv,
    logLevel: level as ServiceConfig["logLevel"],
    database: {
      host: required("POSTGRES_HOST", "localhost"),
      port: numeric("POSTGRES_PORT", 15432),
      username: required("POSTGRES_USER", "app"),
      password: required("POSTGRES_PASSWORD", "app"),
      database: required("DELIVERY_DB", "delivery_db"),
    },
    redis: {
      host: required("REDIS_HOST", "localhost"),
      port: numeric("REDIS_PORT", 16379),
    },
    kafka: {
      brokers: required("KAFKA_BROKERS", "localhost:19092")
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: process.env.KAFKA_CLIENT_ID ?? "delivery",
    },
    outbox: {
      pollIntervalMs: numeric("OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: numeric("OUTBOX_BATCH_SIZE", 100),
    },
    auth: {
      issuer: required("KEYCLOAK_ISSUER", "http://localhost:18080/realms/food-delivery"),
      providerUrl: process.env.KEYCLOAK_INTERNAL_URL || undefined,
      audience: required("AUTH_AUDIENCE", "food-delivery-api"),
      disabled: process.env.AUTH_DISABLED === "true",
    },
    internalToken,
    dispatch: {
      radiusMeters: numeric("DISPATCH_RADIUS_METERS", 3000),
      offerTtlSeconds: numeric("OFFER_TTL_SECONDS", 90),
      freshSeconds: numeric("COURIER_FRESH_SECONDS", 120),
      sweepIntervalMs: numeric("OFFER_SWEEP_INTERVAL_MS", 1000),
    },
    routing: {
      // Пустая строка — маршрутизатор выключен намеренно.
      url: (process.env.OSRM_URL ?? "http://localhost:15000").trim() || null,
      timeoutMs: numeric("OSRM_TIMEOUT_MS", 500),
    },
    locations: {
      positionTtlSeconds: numeric("POSITION_TTL_SECONDS", 60),
      flushIntervalMs: numeric("LOCATION_FLUSH_INTERVAL_MS", 3000),
      maxBuffer: numeric("LOCATION_MAX_BUFFER", 10_000),
    },
  };
}
