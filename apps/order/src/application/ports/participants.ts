import type {
  AuthorizePaymentRequest,
  AuthorizePaymentResponse,
  CapturePaymentRequest,
  CapturePaymentResponse,
  RefundPaymentRequest,
  RefundPaymentResponse,
  ReleaseCourierRequest,
  ReleaseCourierResponse,
  RequestCourierRequest,
  RequestCourierResponse,
  ValidateCartRequest,
  ValidateCartResponse,
  VoidPaymentRequest,
  VoidPaymentResponse,
} from "@food-delivery/contracts";

/**
 * Участники саги — за портами.
 *
 * Сценарии и оркестратор не знают, как устроен вызов: внутренний HTTP
 * с таймаутом, повторами и размыкателем или заглушка на время, пока
 * сервис-участник не готов. Подмена реализации не трогает ни домен,
 * ни сагу; тесты саги идут на тестовых дублях, без сети.
 */

export interface CatalogPort {
  validateCart(restaurantId: string, request: ValidateCartRequest): Promise<ValidateCartResponse>;
}

export interface PaymentPort {
  authorize(request: AuthorizePaymentRequest): Promise<AuthorizePaymentResponse>;
  capture(request: CapturePaymentRequest): Promise<CapturePaymentResponse>;
  void(request: VoidPaymentRequest): Promise<VoidPaymentResponse>;
  refund(request: RefundPaymentRequest): Promise<RefundPaymentResponse>;
}

export interface DeliveryPort {
  requestCourier(request: RequestCourierRequest): Promise<RequestCourierResponse>;
  releaseCourier(request: ReleaseCourierRequest): Promise<ReleaseCourierResponse>;
}

export const CATALOG_PORT = Symbol("CatalogPort");
export const PAYMENT_PORT = Symbol("PaymentPort");
export const DELIVERY_PORT = Symbol("DeliveryPort");
