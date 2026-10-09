import { DEFAULT_TIMEOUTS, type StatusTimeouts } from "../domain/order-timeouts";
import type { SagaSettings } from "../application/saga/saga-settings";

/**
 * Настройки сервиса заказов читаются из переменных окружения — ни одного
 * секрета в коде. Проверка выполняется при запуске: лучше не стартовать
 * вовсе, чем работать с неверной настройкой и узнать об этом на первом заказе.
 */
export interface OrderConfig {
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
    /** Срок жизни корзины: брошенная корзина исчезает сама. */
    cartTtlSeconds: number;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
  };
  /** Фоновый исполнитель саги: как часто и сколько шагов брать. */
  scheduler: {
    pollIntervalMs: number;
    batchSize: number;
    /** Аренда шага: если процесс упадёт посреди шага, через это время шаг возьмут снова. */
    leaseMs: number;
  };
  services: {
    catalogUrl: string;
    /**
     * Платежи и доставка: настоящий сервис по внутреннему HTTP или заглушка
     * внутри процесса — пока сервис-участник не реализован.
     */
    payment: { mode: "http" | "stub"; url: string };
    delivery: { mode: "http" | "stub"; url: string };
    timeoutMs: number;
    breaker: { failureThreshold: number; openDurationMs: number };
  };
  /** Поведение заглушки платежей — для проверки отказов (REL-5). */
  paymentStub: {
    /** Операция, которая всегда отказывает: authorize, capture, void, refund. */
    failOperation: string | null;
    /** Отказ банка на сумму больше указанной, копейки. */
    declineAbove: number | null;
    delayMs: number;
  };
  saga: SagaSettings;
  auth: {
    issuer: string;
    audience: string;
    disabled: boolean;
  };
}

export const ORDER_CONFIG = Symbol("OrderConfig");

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`не задана обязательная переменная окружения ${name}`);
  }
  return value;
}

function numeric(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`переменная окружения ${name} должна быть целым положительным числом`);
  }
  return value;
}

function mode(name: string): "http" | "stub" {
  const value = process.env[name] ?? "stub";
  if (value !== "http" && value !== "stub") {
    throw new Error(`${name} допускает значения http или stub, получено ${value}`);
  }
  return value;
}

function timeouts(): StatusTimeouts {
  return {
    createdMinutes: numeric("ORDER_TIMEOUT_CREATED_MIN", DEFAULT_TIMEOUTS.createdMinutes),
    pendingPaymentMinutes: numeric(
      "ORDER_TIMEOUT_PAYMENT_MIN",
      DEFAULT_TIMEOUTS.pendingPaymentMinutes,
    ),
    awaitingRestaurantMinutes: numeric(
      "ORDER_TIMEOUT_RESTAURANT_MIN",
      DEFAULT_TIMEOUTS.awaitingRestaurantMinutes,
    ),
    cookingOverrunFactor: numeric(
      "ORDER_COOKING_OVERRUN_FACTOR",
      DEFAULT_TIMEOUTS.cookingOverrunFactor,
    ),
    assigningCourierMinutes: numeric(
      "ORDER_TIMEOUT_COURIER_MIN",
      DEFAULT_TIMEOUTS.assigningCourierMinutes,
    ),
    inTransitDefaultMinutes: numeric(
      "ORDER_TIMEOUT_IN_TRANSIT_MIN",
      DEFAULT_TIMEOUTS.inTransitDefaultMinutes,
    ),
  };
}

export function loadConfig(): OrderConfig {
  const level = process.env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error(`недопустимое значение LOG_LEVEL: ${level}`);
  }
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && process.env.AUTH_DISABLED === "true") {
    throw new Error("AUTH_DISABLED запрещён в production");
  }
  const failOperation = process.env.PAYMENT_STUB_FAIL_OPERATION || null;
  if (failOperation && !["authorize", "capture", "void", "refund"].includes(failOperation)) {
    throw new Error(`PAYMENT_STUB_FAIL_OPERATION: неизвестная операция ${failOperation}`);
  }
  const declineAbove = process.env.PAYMENT_STUB_DECLINE_ABOVE
    ? numeric("PAYMENT_STUB_DECLINE_ABOVE", 0)
    : null;

  return {
    port: numeric("ORDER_PORT", 3002),
    nodeEnv,
    logLevel: level as OrderConfig["logLevel"],
    database: {
      host: required("POSTGRES_HOST", "localhost"),
      port: numeric("POSTGRES_PORT", 15432),
      username: required("POSTGRES_USER", "app"),
      password: required("POSTGRES_PASSWORD", "app"),
      database: required("ORDER_DB", "order_db"),
    },
    redis: {
      host: required("REDIS_HOST", "localhost"),
      port: numeric("REDIS_PORT", 16379),
      cartTtlSeconds: numeric("CART_TTL_SECONDS", 24 * 60 * 60),
    },
    kafka: {
      brokers: required("KAFKA_BROKERS", "localhost:19092")
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: process.env.KAFKA_CLIENT_ID ?? "order",
      groupId: process.env.KAFKA_GROUP_ID ?? "order",
    },
    outbox: {
      pollIntervalMs: numeric("OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: numeric("OUTBOX_BATCH_SIZE", 100),
    },
    scheduler: {
      pollIntervalMs: numeric("SAGA_POLL_INTERVAL_MS", 500),
      batchSize: numeric("SAGA_BATCH_SIZE", 20),
      leaseMs: numeric("SAGA_LEASE_MS", 30_000),
    },
    services: {
      catalogUrl: required("CATALOG_URL", "http://localhost:13001"),
      payment: {
        mode: mode("PAYMENT_MODE"),
        url: required("PAYMENT_URL", "http://localhost:13003"),
      },
      delivery: {
        mode: mode("DELIVERY_MODE"),
        url: required("DELIVERY_URL", "http://localhost:13004"),
      },
      timeoutMs: numeric("SERVICE_TIMEOUT_MS", 2000),
      breaker: {
        failureThreshold: numeric("CIRCUIT_FAILURE_THRESHOLD", 5),
        openDurationMs: numeric("CIRCUIT_OPEN_MS", 10_000),
      },
    },
    paymentStub: {
      failOperation,
      declineAbove,
      delayMs: numeric("PAYMENT_STUB_DELAY_MS", 0, true),
    },
    saga: {
      authorizeAttempts: numeric("SAGA_AUTHORIZE_ATTEMPTS", 5),
      captureAttempts: numeric("SAGA_CAPTURE_ATTEMPTS", 5),
      retryBaseMs: numeric("SAGA_RETRY_BASE_MS", 1000),
      retryMaxMs: numeric("SAGA_RETRY_MAX_MS", 30_000),
      attentionAfterAttempts: numeric("SAGA_ATTENTION_AFTER_ATTEMPTS", 5),
      courierRetryDelayMs: numeric("SAGA_COURIER_RETRY_MS", 60_000),
      serviceFee: numeric("ORDER_SERVICE_FEE", 0, true),
      timeouts: timeouts(),
    },
    auth: {
      issuer: required("KEYCLOAK_ISSUER", "http://localhost:18080/realms/food-delivery"),
      audience: required("AUTH_AUDIENCE", "food-delivery-api"),
      disabled: process.env.AUTH_DISABLED === "true",
    },
  };
}
