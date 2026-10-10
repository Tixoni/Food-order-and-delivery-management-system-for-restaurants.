import { ExternalServiceError, TimeoutError, type Logger } from "@food-delivery/shared";
import {
  CircuitBreaker,
  CircuitOpenError,
  isDependencyFailure,
  retry,
} from "@food-delivery/service-kit";
import {
  ProviderRejectedError,
  type HoldRequest,
  type HoldResult,
  type PaymentProvider,
  type ProviderOperation,
  type ProviderPaymentStatus,
} from "../../application/ports/payment-provider";
import { fromProviderValue, toProviderValue } from "../../domain/money";

export interface YooKassaOptions {
  baseUrl: string;
  shopId: string;
  secretKey: string;
  /** Таймаут одной попытки. */
  timeoutMs: number;
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  breaker: { failureThreshold: number; openDurationMs: number };
  logger: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ProviderPaymentBody {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  cancellation_details?: { party?: string; reason?: string };
}

interface ProviderErrorBody {
  code?: string;
  description?: string;
}

/**
 * Адаптер провайдера с контрактом ЮKassa (API v3) — Anti-corruption layer.
 *
 * Здесь и только здесь живут рубли строкой, статусы провайдера и его коды
 * отказов. Наружу адаптер отдаёт три исхода:
 *   результат                 — операция выполнена или банк отказал в холде;
 *   ProviderRejectedError     — отказ по существу (4xx), повтор бессмысленен;
 *   ExternalServiceError/Timeout — сбой связи или 5xx, повтор осмыслен.
 *
 * Повторы — только сбоев и всегда с тем же `Idempotence-Key`: провайдер
 * узнаёт повтор и не двигает деньги дважды. Размыкатель цепи считает только
 * сбои: отказ «платёж уже отменён» — нормальный ответ живого провайдера.
 *
 * В журнал не попадают ни тела запросов, ни тела ответов провайдера (SEC-3):
 * только операция, код ответа и идентификатор платежа.
 */
export class YooKassaProvider implements PaymentProvider {
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(private readonly options: YooKassaOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.authorization = `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString("base64")}`;
    this.breaker = new CircuitBreaker({
      name: "payment-provider",
      ...options.breaker,
      onStateChange: (state) =>
        options.logger.warn("состояние размыкателя провайдера изменилось", { state }),
    });
  }

  get circuitState() {
    return this.breaker.currentState;
  }

  async hold(request: HoldRequest): Promise<HoldResult> {
    const body = await this.call<ProviderPaymentBody>(
      "hold",
      "/v3/payments",
      request.idempotencyKey,
      {
        amount: { value: toProviderValue(request.amount), currency: request.currency },
        // Двухстадийная оплата: сначала холд, списание — после подтверждения
        // рестораном (PAY-1, PAY-2).
        capture: false,
        description: `Заказ ${request.orderId}`,
        metadata: { orderId: request.orderId },
      },
    );

    if (body.status === "waiting_for_capture") return { providerPaymentId: body.id, held: true };
    if (body.status === "canceled") {
      return {
        providerPaymentId: body.id,
        held: false,
        declineReason: body.cancellation_details?.reason ?? "declined",
      };
    }
    // `pending` — платёж ждёт действий покупателя (3-D Secure). В прототипе
    // этого шага нет; считать такой ответ холдом нельзя.
    throw new ExternalServiceError("провайдер вернул незавершённый холд", { status: body.status });
  }

  async capture(request: ProviderOperation & { amount: number }): Promise<void> {
    await this.call(
      "capture",
      `/v3/payments/${encodeURIComponent(request.providerPaymentId)}/capture`,
      request.idempotencyKey,
      { amount: { value: toProviderValue(request.amount), currency: "RUB" } },
    );
  }

  async cancel(request: ProviderOperation): Promise<void> {
    await this.call(
      "cancel",
      `/v3/payments/${encodeURIComponent(request.providerPaymentId)}/cancel`,
      request.idempotencyKey,
      {},
    );
  }

  async status(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const body = await this.call<ProviderPaymentBody & { refunded_amount?: { value: string } }>(
      "status",
      `/v3/payments/${encodeURIComponent(providerPaymentId)}`,
      null,
      undefined,
    );
    return {
      status: body.status,
      refundedAmount: body.refunded_amount ? fromProviderValue(body.refunded_amount.value) : 0,
    };
  }

  async refund(request: ProviderOperation & { amount: number }): Promise<{ refundId: string }> {
    const body = await this.call<{ id: string }>("refund", "/v3/refunds", request.idempotencyKey, {
      payment_id: request.providerPaymentId,
      amount: { value: toProviderValue(request.amount), currency: "RUB" },
    });
    return { refundId: body.id };
  }

  /** `key = null` — чтение (GET): ключ идемпотентности ему не нужен. */
  private call<T>(operation: string, path: string, key: string | null, body: unknown): Promise<T> {
    const once = () =>
      this.breaker.execute(() => this.send<T>(operation, path, key, body), isDependencyFailure);

    return retry(once, {
      ...this.options.retry,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      // Разомкнутую цепь не повторяем: ответ через сотню миллисекунд будет тем же.
      retryOn: (error) => isDependencyFailure(error) && !(error instanceof CircuitOpenError),
      onRetry: (error, attempt) =>
        this.options.logger.debug("повтор вызова провайдера", {
          operation,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  private async send<T>(
    operation: string,
    path: string,
    key: string | null,
    body: unknown,
  ): Promise<T> {
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: key === null ? "GET" : "POST",
        headers: {
          authorization: this.authorization,
          ...(key === null ? {} : { "idempotence-key": key, "content-type": "application/json" }),
        },
        ...(key === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      this.options.logger.warn("провайдер не ответил", { operation, timedOut });
      throw timedOut
        ? new TimeoutError("платёжный провайдер не ответил вовремя", { operation })
        : new ExternalServiceError("платёжный провайдер недоступен", { operation });
    }

    const payload = (await response.json().catch(() => ({}))) as T & ProviderErrorBody;
    this.options.logger.info("ответ провайдера", {
      operation,
      status: response.status,
      ms: Date.now() - started,
    });

    if (response.status >= 500) {
      throw new ExternalServiceError("платёжный провайдер ответил ошибкой", {
        operation,
        status: response.status,
      });
    }
    if (response.status === 401 || response.status === 403) {
      // Неверные учётные данные магазина — ошибка настройки, а не отказ по
      // существу: исправляется не повтором, а конфигурацией.
      this.options.logger.error("провайдер не принял учётные данные магазина", undefined, {
        operation,
      });
      throw new ExternalServiceError("платёжный провайдер отклонил учётные данные", { operation });
    }
    if (!response.ok) {
      throw new ProviderRejectedError(
        payload.description ?? "операция отклонена",
        payload.code ?? "invalid_request",
      );
    }
    return payload;
  }
}
