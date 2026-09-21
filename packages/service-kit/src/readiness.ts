/**
 * Проверка готовности — то, от чего зависит способность сервиса работать.
 * Каждый сервис объявляет свой набор: каталогу нужна база, шлюзу — ничего.
 */
export interface ReadinessCheckResult {
  status: "ok" | "fail";
  latencyMs?: number;
  error?: string;
}

export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<ReadinessCheckResult>;
}

/** Метка для внедрения списка проверок: интерфейсов во время выполнения не существует. */
export const READINESS_CHECKS = Symbol("ReadinessChecks");

/** Имя сервиса — попадает в ответы проверок, метрики и записи журнала. */
export const SERVICE_NAME = Symbol("ServiceName");
