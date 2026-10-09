import { randomUUID } from "node:crypto";
import { DomainRuleError, ExternalServiceError } from "@food-delivery/shared";
import type {
  AuthorizePaymentRequest,
  AuthorizePaymentResponse,
  CapturePaymentRequest,
  CapturePaymentResponse,
  RefundPaymentRequest,
  RefundPaymentResponse,
  ReleaseCourierRequest,
  RequestCourierRequest,
  VoidPaymentRequest,
  VoidPaymentResponse,
} from "@food-delivery/contracts";
import type { DeliveryPort, PaymentPort } from "../../application/ports/participants";

export interface PaymentStubOptions {
  failOperation: string | null;
  declineAbove: number | null;
  delayMs: number;
}

/**
 * Заглушка платёжного сервиса внутри процесса — до реализации `payment`.
 *
 * Не «всегда успех»: эмулятор держит то же поведение, что и настоящий
 * сервис по контракту, — идемпотентность по ключу, холд → списание →
 * возврат, отказ снять холд со списанного платежа. И умеет управляемые
 * отказы: без них не проверить компенсации саги (REL-5). Отказ включается
 * переменными окружения (`PAYMENT_STUB_FAIL_OPERATION`,
 * `PAYMENT_STUB_DECLINE_ABOVE`, `PAYMENT_STUB_DELAY_MS`).
 *
 * Состояние в памяти и теряется при перезапуске — это граница заглушки;
 * настоящий сервис хранит его в `payment_db`.
 */
export class PaymentStub implements PaymentPort {
  private readonly responses = new Map<string, unknown>();
  private readonly payments = new Map<
    string,
    { id: string; status: string; amount: number; captured: number; refunded: number }
  >();

  constructor(private readonly options: PaymentStubOptions) {}

  authorize(request: AuthorizePaymentRequest) {
    return this.run<AuthorizePaymentResponse>("authorize", request.idempotencyKey, () => {
      const id = this.payments.get(request.orderId)?.id ?? randomUUID();
      if (this.options.declineAbove !== null && request.amount > this.options.declineAbove) {
        this.payments.set(request.orderId, {
          id,
          status: "DECLINED",
          amount: request.amount,
          captured: 0,
          refunded: 0,
        });
        return { paymentId: id, status: "DECLINED", declineReason: "банк отклонил операцию" };
      }
      this.payments.set(request.orderId, {
        id,
        status: "AUTHORIZED",
        amount: request.amount,
        captured: 0,
        refunded: 0,
      });
      return { paymentId: id, status: "AUTHORIZED" };
    });
  }

  capture(request: CapturePaymentRequest) {
    return this.run<CapturePaymentResponse>("capture", request.idempotencyKey, () => {
      const payment = this.payments.get(request.orderId);
      if (!payment || payment.status !== "AUTHORIZED") {
        throw new DomainRuleError("списать можно только захолдированный платёж");
      }
      payment.status = "CAPTURED";
      payment.captured = payment.amount;
      return { paymentId: payment.id, status: "CAPTURED", amount: payment.amount };
    });
  }

  void(request: VoidPaymentRequest) {
    return this.run<VoidPaymentResponse>("void", request.idempotencyKey, () => {
      const payment = this.payments.get(request.orderId);
      if (payment?.status === "CAPTURED") {
        throw new DomainRuleError("нельзя снять холд со списанного платежа");
      }
      if (payment?.status !== "AUTHORIZED")
        return { paymentId: payment?.id ?? null, voided: false };
      payment.status = "VOIDED";
      return { paymentId: payment.id, voided: true };
    });
  }

  refund(request: RefundPaymentRequest) {
    return this.run<RefundPaymentResponse>("refund", request.idempotencyKey, () => {
      const payment = this.payments.get(request.orderId);
      if (!payment || payment.captured === 0) {
        throw new DomainRuleError("вернуть можно только списанные средства");
      }
      payment.refunded = Math.min(payment.captured, payment.refunded + request.amount);
      payment.status = payment.refunded >= payment.captured ? "REFUNDED" : "PARTIALLY_REFUNDED";
      return {
        paymentId: payment.id,
        status: payment.status as RefundPaymentResponse["status"],
        refundedTotal: payment.refunded,
      };
    });
  }

  private async run<T>(operation: string, key: string, action: () => T): Promise<T> {
    if (this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.failOperation === operation) {
      throw new ExternalServiceError(`эмулятор платежей: отказ операции ${operation}`);
    }
    // Повтор с тем же ключом — тот же ответ, операция не выполняется снова (PAY-4).
    if (this.responses.has(key)) return this.responses.get(key) as T;
    const result = action();
    this.responses.set(key, result);
    return result;
  }
}

/**
 * Заглушка сервиса доставки — до итерации 3. Принимает запрос курьера
 * и ничего не публикует: события о курьере появятся вместе с `delivery`.
 * Пока их можно подать в топик `delivery.events` проверочным сценарием.
 */
export class DeliveryStub implements DeliveryPort {
  private readonly deliveries = new Map<string, string>();

  async requestCourier(request: RequestCourierRequest) {
    const id = this.deliveries.get(request.orderId) ?? randomUUID();
    this.deliveries.set(request.orderId, id);
    return { deliveryId: id, status: "PENDING" as const };
  }

  async releaseCourier(request: ReleaseCourierRequest) {
    return { released: this.deliveries.delete(request.orderId) };
  }
}
