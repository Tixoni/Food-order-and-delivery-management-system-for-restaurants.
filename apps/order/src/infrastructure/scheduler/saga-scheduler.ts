import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Counter } from "prom-client";
import { createLogger, type Logger } from "@food-delivery/shared";
import { MetricsService, continueTrace } from "@food-delivery/service-kit";
import { SagaRunner } from "../../application/saga/saga-runner";
import { SAGA_QUEUE, type SagaQueue } from "../../application/ports/saga-queue";
import { ORDER_CONFIG, type OrderConfig } from "../../config/configuration";

/**
 * Фоновый исполнитель саги: раз в полсекунды берёт наступившие шаги
 * и таймеры из базы и выполняет их.
 *
 * Не `setTimeout` на каждый заказ: таймер в памяти теряется при перезапуске,
 * и заказ зависает навсегда (REL-6). Здесь в памяти только сам опрос,
 * а что и когда делать — в таблице `saga_timers`. Перезапуск сервиса
 * продолжает с того же места, вторая реплика не возьмёт чужой шаг.
 */
@Injectable()
export class SagaScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: Logger;
  private readonly steps: Counter<"step" | "outcome">;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly runner: SagaRunner,
    @Inject(SAGA_QUEUE) private readonly queue: SagaQueue,
    @Inject(ORDER_CONFIG) private readonly config: OrderConfig,
    metrics: MetricsService,
  ) {
    this.logger = createLogger({ service: "order", level: config.logLevel }).child({
      component: "saga",
    });
    // Бизнес-метрика для дашборда (OBS-3): шаги саги по исходу. Рост «retry»
    // и «error» виден раньше, чем жалобы клиентов.
    this.steps = new Counter({
      name: "order_saga_steps_total",
      help: "Шаги и таймеры саги по исходу",
      labelNames: ["step", "outcome"] as const,
      registers: [metrics.registry],
    });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.config.scheduler.pollIntervalMs);
    this.timer.unref?.();
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход. Пропускается, если предыдущий не закончился. */
  async tick(): Promise<number> {
    if (this.busy || this.stopped) return 0;
    this.busy = true;
    try {
      const entries = await this.queue.claimDue(
        this.config.scheduler.batchSize,
        this.config.scheduler.leaseMs,
      );
      for (const entry of entries) {
        const step = entry.type.startsWith("TIMEOUT:") ? "TIMEOUT" : entry.type;
        try {
          // Шаг саги — значимое событие (холд, списание, курьер, компенсации),
          // их несколько на заказ: в журнал на уровне info, с идентификатором
          // оформления — шаги видны в «Журнале действия» рядом с запросами.
          // Шаг — продолжение трассы, в которой его поставили (OBS-2):
          // холд — в трассе оформления, снятие холда — в трассе отмены.
          const outcome = await continueTrace(
            {
              carrier: entry.traceContext,
              name: `saga ${entry.type}`,
              attributes: {
                "order.id": entry.orderId,
                "saga.step": entry.type,
                "saga.attempt": entry.attempt,
              },
            },
            () =>
              this.runner.run(entry, new Date(), (result) =>
                this.logger.info("шаг саги выполнен", {
                  orderId: entry.orderId,
                  type: entry.type,
                  outcome: result,
                  attempt: entry.attempt,
                }),
              ),
          );
          this.steps.inc({ step, outcome });
        } catch (error) {
          // Шаг остаётся в аренде и будет взят снова, когда она истечёт.
          this.steps.inc({ step, outcome: "error" });
          this.logger.error("шаг саги завершился ошибкой", error, {
            orderId: entry.orderId,
            type: entry.type,
            attempt: entry.attempt,
          });
        }
      }
      return entries.length;
    } catch (error) {
      this.logger.warn("очередь саги недоступна", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
