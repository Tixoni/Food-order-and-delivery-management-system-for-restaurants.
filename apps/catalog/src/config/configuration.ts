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
}

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

  return {
    port: numeric("CATALOG_PORT", 3001),
    nodeEnv: process.env.NODE_ENV ?? "development",
    logLevel: level as CatalogConfig["logLevel"],
    database: {
      host: required("POSTGRES_HOST", "localhost"),
      port: numeric("POSTGRES_PORT", 15432),
      username: required("POSTGRES_USER", "app"),
      password: required("POSTGRES_PASSWORD", "app"),
      database: required("CATALOG_DB", "catalog_db"),
    },
  };
}
