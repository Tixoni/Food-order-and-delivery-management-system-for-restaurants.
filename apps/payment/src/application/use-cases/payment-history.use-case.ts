import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import { PAYMENT_REPOSITORY, type PaymentRepository } from "../ports/payment.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Денежная история заказа: платежи и неизменяемый журнал операций.
 * Нужна оператору при разборе спорного заказа и сверке с провайдером.
 *
 * Сквозной идентификатор из записи операции наружу не отдаётся, ответ
 * провайдера — тоже: только то, что сервис сам сохранил о результате.
 */
@Injectable()
export class PaymentHistoryUseCase {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository) {}

  async ofOrder(orderId: string) {
    if (!UUID.test(orderId)) throw new ValidationError("orderId: нужен идентификатор заказа");
    const { payments, transactions } = await this.payments.history(orderId);

    return {
      orderId,
      payments: payments.map((payment) => ({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        refundedAmount: payment.refundedAmount,
        authorizedAt: payment.authorizedAt,
        capturedAt: payment.capturedAt,
      })),
      transactions: transactions.map((transaction) => ({
        id: transaction.id,
        paymentId: transaction.paymentId,
        type: transaction.type,
        amount: transaction.amount,
        status: transaction.status,
        idempotencyKey: transaction.idempotencyKey,
        errorCode: transaction.errorCode,
        createdAt: transaction.createdAt,
        finishedAt: transaction.finishedAt,
      })),
    };
  }
}
