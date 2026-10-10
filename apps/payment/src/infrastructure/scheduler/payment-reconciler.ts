import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createLogger, type Logger } from "@food-delivery/shared";
import {
  PAYMENT_REPOSITORY,
  type PaymentRepository,
} from "../../application/ports/payment.repository";
import { PaymentOperationsUseCase } from "../../application/use-cases/payment-operations.use-case";
import { PAYMENT_CONFIG, type PaymentConfig } from "../../config/configuration";

/**
 * Сверка незавершённых операций.
 *
 * Операция остаётся в PENDING, если процесс упал между ответом провайдера
 * и фиксацией итога или если провайдер не ответил. Деньги при этом могли
 * сдвинуться, и `order` должен об этом узнать — событием.
 *
 * Сверка не выполняет брошенные операции, а узнаёт их итог у провайдера
 * (см. `PaymentOperationsUseCase.reconcile`): прошла — фиксируется и
 * публикуется; не прошла — остаётся вызывающему. Единственное исключение —
 * холд: он повторяется с тем же ключом, а поздний холд `order` снимет сам.
 *
 * Первая версия сверки повторяла все операции — и проверка отказа на
 * списании показала, чем это плохо: сверка списала деньги через минуту
 * после того, как оркестратор от списания отказался и уже снимал холд,
 * а её повторы держали размыкатель к провайдеру открытым и мешали самой
 * компенсации. Заказ сошёлся только через возврат и за 62 с вместо 60.
 *
 * Сверку безопасно выполнять с нескольких реплик одновременно: чтение
 * у провайдера ничего не двигает, итог фиксируется только поверх PENDING.
 * Операции старше окна сверки автоматически не трогаются — они требуют
 * ручного разбора.
 */
@Injectable()
export class PaymentReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly operations: PaymentOperationsUseCase,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {
    this.logger = createLogger({ service: "payment", level: config.logLevel }).child({
      component: "reconciler",
    });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), this.config.reconcile.intervalMs);
    // Таймер не должен удерживать процесс при завершении работы.
    this.timer.unref?.();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход сверки; возвращает, сколько операций доведено. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let settled = 0;
    try {
      const { afterMs, windowMs, batchSize } = this.config.reconcile;
      const pending = await this.payments.pending(afterMs, windowMs, batchSize);

      for (const operation of pending) {
        try {
          if (await this.operations.reconcile(operation)) {
            settled += 1;
            this.logger.info("незавершённая операция сверена с провайдером и закрыта", {
              transactionId: operation.transaction.id,
              type: operation.transaction.type,
            });
          }
        } catch (error) {
          // Провайдер всё ещё недоступен — попробует следующий проход.
          this.logger.warn("сверка операции не удалась", {
            transactionId: operation.transaction.id,
            type: operation.transaction.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn("сверка не выполнена", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
    }
    return settled;
  }
}
