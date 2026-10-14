import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { createLogger, getContext, type LogLevel, type Logger } from "@food-delivery/shared";
import { MetricsService } from "./metrics.service";
import { SERVICE_NAME } from "./readiness";

/** Проверки живости и сбор метрик опрашиваются каждые несколько секунд — в журнал не идут. */
const QUIET_PATHS = new Set(["/health", "/ready", "/metrics"]);

const OPERATION_NAME = /^[A-Za-z0-9_]{1,64}$/;

export interface LoggedRequest {
  method: string;
  url: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: string };
  body?: unknown;
}

export interface LoggedResponse {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
}

/**
 * Журнал запросов и показатели RED (OBS-1, OBS-3) — одна запись на запрос.
 *
 * Пишется метод, шаблон маршрута (`/restaurants/:id/menu`), код ответа и
 * длительность; сквозной идентификатор подставляется сам. Строка запроса
 * не пишется: в ней бывают координаты адреса клиента (SEC-4). У GraphQL
 * один адрес на все операции — поэтому добавляется имя операции.
 *
 * Метка маршрута в метриках — шаблон, а не настоящий путь: иначе каждый
 * идентификатор заказа давал бы новый временной ряд.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger: Logger;

  constructor(
    private readonly metrics: MetricsService,
    @Inject(SERVICE_NAME) serviceName: string,
  ) {
    this.logger = createLogger({ service: serviceName, level: levelFromEnv() }).child({
      component: "http",
    });
  }

  use(request: LoggedRequest, response: LoggedResponse, next: () => void) {
    const path = (request.originalUrl ?? request.url).split("?")[0];
    if (QUIET_PATHS.has(path)) return next();

    const started = process.hrtime.bigint();
    // Контекст запроса фиксируется сразу: событие завершения может прийти
    // уже вне его.
    const correlationId = getContext()?.correlationId;

    response.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeOf(request, path);
      const labels = { method: request.method, route, status: String(response.statusCode) };
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, seconds);

      const fields = {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(seconds * 1000),
        ...(correlationId ? { correlationId } : {}),
        ...operationOf(request),
      };
      if (response.statusCode >= 500) this.logger.warn("запрос завершился ошибкой", fields);
      else this.logger.info("запрос обработан", fields);
    });
    next();
  }
}

/** Шаблон маршрута из маршрутизатора; не найден маршрут — одна общая метка. */
function routeOf(request: LoggedRequest, path: string): string {
  if (request.route?.path) return `${request.baseUrl ?? ""}${request.route.path}`;
  if (path === "/graphql") return path;
  return "unmatched";
}

function operationOf(request: LoggedRequest): { operation?: string } {
  const name = (request.body as { operationName?: unknown } | undefined)?.operationName;
  return typeof name === "string" && OPERATION_NAME.test(name) ? { operation: name } : {};
}

function levelFromEnv(): LogLevel {
  const level = process.env.LOG_LEVEL;
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}
