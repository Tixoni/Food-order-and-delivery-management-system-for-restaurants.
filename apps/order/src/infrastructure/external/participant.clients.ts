import {
  DELIVERY_API,
  PAYMENT_API,
  type AuthorizePaymentRequest,
  type AuthorizePaymentResponse,
  type CapturePaymentRequest,
  type CapturePaymentResponse,
  type RefundPaymentRequest,
  type RefundPaymentResponse,
  type ReleaseCourierRequest,
  type ReleaseCourierResponse,
  type RequestCourierRequest,
  type RequestCourierResponse,
  type ValidateCartRequest,
  type ValidateCartResponse,
  type VoidPaymentRequest,
  type VoidPaymentResponse,
} from "@food-delivery/contracts";
import type { InternalHttpClient } from "@food-delivery/service-kit";
import type { CatalogPort, DeliveryPort, PaymentPort } from "../../application/ports/participants";

/**
 * Участники саги по внутреннему HTTP.
 *
 * Таймаут, повторы и размыкатель цепи — в общем клиенте каркаса. Повторы
 * разрешены всем вызовам: проверка корзины ничего не меняет, а платёжные
 * операции и вызов курьера несут ключ идемпотентности, по которому
 * получатель узнаёт повтор (PAY-4).
 */

export class CatalogHttpClient implements CatalogPort {
  constructor(private readonly http: InternalHttpClient) {}

  validateCart(restaurantId: string, request: ValidateCartRequest) {
    return this.http.request<ValidateCartResponse>({
      method: "POST",
      path: `/restaurants/${encodeURIComponent(restaurantId)}/validate-cart`,
      body: request,
      idempotent: true,
    });
  }
}

export class PaymentHttpClient implements PaymentPort {
  constructor(private readonly http: InternalHttpClient) {}

  authorize(request: AuthorizePaymentRequest) {
    return this.post<AuthorizePaymentResponse>(PAYMENT_API.authorize, request);
  }
  capture(request: CapturePaymentRequest) {
    return this.post<CapturePaymentResponse>(PAYMENT_API.capture, request);
  }
  void(request: VoidPaymentRequest) {
    return this.post<VoidPaymentResponse>(PAYMENT_API.void, request);
  }
  refund(request: RefundPaymentRequest) {
    return this.post<RefundPaymentResponse>(PAYMENT_API.refund, request);
  }

  private post<T>(path: string, body: unknown) {
    return this.http.request<T>({ method: "POST", path, body, idempotent: true });
  }
}

export class DeliveryHttpClient implements DeliveryPort {
  constructor(private readonly http: InternalHttpClient) {}

  requestCourier(request: RequestCourierRequest) {
    return this.http.request<RequestCourierResponse>({
      method: "POST",
      path: DELIVERY_API.request,
      body: request,
      idempotent: true,
    });
  }

  releaseCourier(request: ReleaseCourierRequest) {
    return this.http.request<ReleaseCourierResponse>({
      method: "POST",
      path: DELIVERY_API.release,
      body: request,
      idempotent: true,
    });
  }
}
