import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { ReadinessCheck, ReadinessCheckResult } from "@food-delivery/service-kit";

/**
 * Без базы каталог работать не может, поэтому её доступность входит
 * в проверку готовности: сервис с оборванным соединением не должен
 * получать трафик.
 */
@Injectable()
export class DatabaseReadinessCheck implements ReadinessCheck {
  readonly name = "database";

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async check(): Promise<ReadinessCheckResult> {
    const startedAt = Date.now();
    try {
      await this.dataSource.query("SELECT 1");
      return { status: "ok", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "fail",
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
