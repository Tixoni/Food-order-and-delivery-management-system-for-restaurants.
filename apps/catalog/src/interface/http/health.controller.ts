import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/**
 * Две разные проверки, и различие между ними существенное.
 *
 * /health — «процесс жив». Отвечает всегда, пока сервис не завис.
 *           По ней оркестратор решает, не пора ли перезапустить контейнер.
 *
 * /ready  — «готов принимать запросы». Проверяет связь с базой.
 *           По ней балансировщик решает, направлять ли сюда трафик.
 *
 * Если их не разделить, сервис с оборванным соединением к базе будет
 * считаться исправным и начнёт отвечать ошибками на каждый запрос.
 */
@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get("health")
  @HttpCode(HttpStatus.OK)
  health() {
    return {
      status: "ok",
      service: "catalog",
      uptimeSec: Math.round(process.uptime()),
    };
  }

  @Get("ready")
  async ready() {
    const startedAt = Date.now();
    try {
      await this.dataSource.query("SELECT 1");
    } catch (error) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        service: "catalog",
        reason: "база данных недоступна",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      status: "ready",
      service: "catalog",
      checks: { database: { status: "ok", latencyMs: Date.now() - startedAt } },
    };
  }
}
