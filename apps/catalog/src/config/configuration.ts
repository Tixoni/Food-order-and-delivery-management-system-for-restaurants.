/**
 * Настройки сервиса читаются из переменных окружения — ни одного секрета в коде.
 * Проверка выполняется при запуске: лучше не стартовать вовсе, чем работать
 * с неверной настройкой и обнаружить это на первом запросе.
 */
export interface CatalogConfig {
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
  redis: {
    host: string;
    port: number;
    /**
     * Срок жизни кэша меню. Это страховка на случай потери события,
     * а не основной способ обновления: при изменении меню кэш
     * сбрасывается сразу (CAT-4).
     */
    menuTtlSeconds: number;
  };
  kafka: {
    brokers: string[];
    clientId: string;
  };
  outbox: {
    /** Как часто проверяются неотправленные сообщения. Прямо влияет на CAT-4. */
    pollIntervalMs: number;
    batchSize: number;
  };
  auth: {
    /** Область провайдера входа: по её адресу берутся ключи проверки подписи. */
    issuer: string;
    /** Внутренний адрес провайдера входа; не задан — совпадает с издателем. */
    providerUrl?: string;
    audience: string;
    /**
     * Работа без провайдера входа. Включается только для разработки,
     * когда Keycloak не поднят; в рабочем окружении означало бы систему
     * без проверки прав, поэтому значение по умолчанию — ложь.
     */
    disabled: boolean;
  };
}

/** Метка для внедрения настроек: интерфейса во время выполнения не существует. */
export const CATALOG_CONFIG = Symbol("CatalogConfig");

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

export function loadConfig(): CatalogConfig {
  const level = process.env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error(`недопустимое значение LOG_LEVEL: ${level}`);
  }
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && process.env.AUTH_DISABLED === "true") {
    throw new Error("AUTH_DISABLED запрещён в production");
  }

  return {
    port: numeric("CATALOG_PORT", 3001),
    nodeEnv,
    logLevel: level as CatalogConfig["logLevel"],
    database: {
      host: required("POSTGRES_HOST", "localhost"),
      port: numeric("POSTGRES_PORT", 15432),
      username: required("POSTGRES_USER", "app"),
      password: required("POSTGRES_PASSWORD", "app"),
      database: required("CATALOG_DB", "catalog_db"),
    },
    redis: {
      host: required("REDIS_HOST", "localhost"),
      port: numeric("REDIS_PORT", 16379),
      menuTtlSeconds: numeric("MENU_CACHE_TTL_SECONDS", 2),
    },
    kafka: {
      // Список через запятую: в рабочем окружении брокеров несколько,
      // и клиент должен знать их все, иначе отказ одного узла
      // сделает недоступным весь брокер.
      brokers: required("KAFKA_BROKERS", "localhost:19092")
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: process.env.KAFKA_CLIENT_ID ?? "catalog",
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
  };
}
