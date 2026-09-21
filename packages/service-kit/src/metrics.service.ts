import { Inject, Injectable } from "@nestjs/common";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import { SERVICE_NAME } from "./readiness";

/**
 * Показатели по модели RED: частота обращений, доля ошибок, длительность.
 * Требование OBS-3.
 *
 * Собираются с первого дня, а не добавляются в конце: иначе к моменту
 * нагрузочного тестирования не с чем будет сравнивать.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests: Counter<"method" | "route" | "status">;
  readonly httpDuration: Histogram<"method" | "route" | "status">;

  constructor(@Inject(SERVICE_NAME) serviceName: string) {
    this.registry.setDefaultLabels({ service: serviceName });
    collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: "http_requests_total",
      help: "Количество обработанных запросов",
      labelNames: ["method", "route", "status"] as const,
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "Длительность обработки запроса",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 3],
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
