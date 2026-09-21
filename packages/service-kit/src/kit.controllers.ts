import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { READINESS_CHECKS, SERVICE_NAME, type ReadinessCheck } from "./readiness";

/**
 * Две разные проверки, и различие между ними существенное.
 *
 * /health — «процесс жив». Отвечает всегда, пока сервис не завис.
 *           По ней оркестратор решает, не пора ли перезапустить контейнер.
 *
 * /ready  — «готов принимать запросы». Проверяет то, без чего работать нельзя.
 *           По ней балансировщик решает, направлять ли сюда трафик.
 *
 * Если их не разделить, сервис с оборванным соединением к базе будет
 * считаться исправным и начнёт отвечать ошибками на каждый запрос.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly serviceName: string,
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
  ) {}

  @Get("health")
  @HttpCode(HttpStatus.OK)
  health() {
    return {
      status: "ok",
      service: this.serviceName,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  @Get("ready")
  async ready() {
    const results = await Promise.all(
      this.checks.map(async (check) => [check.name, await check.check()] as const),
    );

    const checks = Object.fromEntries(results);
    const failed = results.filter(([, result]) => result.status === "fail");

    if (failed.length > 0) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        service: this.serviceName,
        checks,
      });
    }

    return { status: "ready", service: this.serviceName, checks };
  }
}

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
