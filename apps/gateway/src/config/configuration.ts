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
  redis: {
    host: string;
    port: number;
    /** Срок жизни кэша выдачи каталога. Сбрасывается событиями каталога. */
    cacheTtlSeconds: number;
  };
  auth: {
    /** Область провайдера входа: и для проверки подписи, и для самого входа. */
    issuer: string;
    audience: string;
    /** Приложение, от имени которого выполняется вход. */
    clientId: string;
    /** Сколько ждать ответа провайдера, прежде чем считать его недоступным. */
    timeoutMs: number;
    disabled: boolean;
  };
  /** Адреса сервисов, к которым обращается шлюз. */
  services: {
    catalog: string;
    /**
     * Сколько шлюз ждёт ответа сервиса. Предел нужен обязательно: без него
     * зависший сосед удерживает соединения шлюза, и через несколько минут
     * шлюз перестаёт отвечать всем — отказ одного сервиса становится
     * отказом системы (REL-2).
     */
    timeoutMs: number;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
  };
}

/** Метка для внедрения настроек: интерфейса во время выполнения не существует. */
export const GATEWAY_CONFIG = Symbol("GatewayConfig");

/** Псевдоним по имени сервиса — так же, как в catalog. */
export type GatewayConfig = ServiceConfig;

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

  return {
    port: numeric("GATEWAY_PORT", 3000),
    nodeEnv,
    logLevel: level as ServiceConfig["logLevel"],
    redis: {
      host: required("REDIS_HOST", "localhost"),
      port: numeric("REDIS_PORT", 16379),
      cacheTtlSeconds: numeric("GATEWAY_CACHE_TTL_SECONDS", 2),
    },
    auth: {
      issuer: required("KEYCLOAK_ISSUER", "http://localhost:18080/realms/food-delivery"),
      audience: required("AUTH_AUDIENCE", "food-delivery-api"),
      clientId: required("AUTH_CLIENT_ID", "web"),
      timeoutMs: numeric("AUTH_TIMEOUT_MS", 5000),
      disabled: process.env.AUTH_DISABLED === "true",
    },
    services: {
      catalog: required("CATALOG_URL", "http://localhost:3001"),
      timeoutMs: numeric("SERVICE_TIMEOUT_MS", 3000),
    },
    kafka: {
      brokers: required("KAFKA_BROKERS", "localhost:19092")
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: process.env.KAFKA_CLIENT_ID ?? "gateway",
      // Реплики используют общий Redis: одной доставки события на группу
      // достаточно для сброса общего кэша. PID контейнеров часто равен 1.
      groupId: process.env.KAFKA_GROUP_ID ?? "gateway-cache",
    },
  };
}
