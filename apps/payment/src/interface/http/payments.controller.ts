import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import {
  PAYMENT_API,
  type AuthorizePaymentRequest,
  type CapturePaymentRequest,
  type RefundPaymentRequest,
  type VoidPaymentRequest,
} from "@food-delivery/contracts";
import { InternalTokenGuard } from "@food-delivery/service-kit";
import { PaymentOperationsUseCase } from "../../application/use-cases/payment-operations.use-case";
import { PaymentHistoryUseCase } from "../../application/use-cases/payment-history.use-case";

/**
 * Внутренний API платёжного сервиса — контракт `PAYMENT_API` из
 * `packages/contracts`. Наружу через шлюз не выходит; вызывает его только
 * оркестратор саги в `order`, со служебным токеном.
 *
 * Отказ банка — ответ 200 со статусом DECLINED; ошибки — только там, где
 * операция действительно не выполнена: 422 — нарушено правило (повтор
 * бессмысленен), 502/504 — провайдер недоступен (повтор осмыслен).
 */
@Controller()
@UseGuards(InternalTokenGuard)
export class PaymentsController {
  constructor(
    private readonly operations: PaymentOperationsUseCase,
    private readonly history: PaymentHistoryUseCase,
  ) {}

  @Post(PAYMENT_API.authorize)
  @HttpCode(200)
  authorize(@Body() body: AuthorizePaymentRequest) {
    return this.operations.authorize(body ?? ({} as AuthorizePaymentRequest));
  }

  @Post(PAYMENT_API.capture)
  @HttpCode(200)
  capture(@Body() body: CapturePaymentRequest) {
    return this.operations.capture(body ?? ({} as CapturePaymentRequest));
  }

  @Post(PAYMENT_API.void)
  @HttpCode(200)
  void(@Body() body: VoidPaymentRequest) {
    return this.operations.void(body ?? ({} as VoidPaymentRequest));
  }

  @Post(PAYMENT_API.refund)
  @HttpCode(200)
  refund(@Body() body: RefundPaymentRequest) {
    return this.operations.refund(body ?? ({} as RefundPaymentRequest));
  }

  /** Вся денежная история заказа одним запросом: платежи и журнал операций. */
  @Get("payments/orders/:orderId")
  ofOrder(@Param("orderId") orderId: string) {
    return this.history.ofOrder(orderId);
  }
}
