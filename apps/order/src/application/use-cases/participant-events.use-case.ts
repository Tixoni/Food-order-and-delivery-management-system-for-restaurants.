import { Inject, Injectable } from "@nestjs/common";
import {
  DELIVERY_EVENT_TYPES,
  PAYMENT_EVENT_TYPES,
  type CourierAcceptedPayload,
  type CourierAssignedPayload,
  type CourierNotFoundPayload,
  type DeliveryCompletedPayload,
  type DeliveryEventBase,
  type OrderPickedUpPayload,
  type PaymentAuthorizedPayload,
  type PaymentCapturedPayload,
  type PaymentEventBase,
  type PaymentFailedPayload,
  type PaymentRefundedPayload,
} from "@food-delivery/contracts";
import type { DomainEvent } from "@food-delivery/shared";
import { SAGA_STEPS } from "../../domain/checkout-saga";
import { SYSTEM } from "../../domain/order";
import { domain } from "../domain-errors";
import {
  DuplicateMessageError,
  ORDER_REPOSITORY,
  type LoadedOrder,
  type OrderRepository,
} from "../ports/order.repository";
import { ORDER_COMMITTER, type CommitOptions, type OrderCommitter } from "../saga/order-committer";
import { ORDER_WORKFLOW, type OrderWorkflow } from "../saga/order-workflow";
import { SAGA_SETTINGS, type SagaSettings } from "../saga/saga-settings";

export const PAYMENT_CONSUMER = "order:payment-events";
export const DELIVERY_CONSUMER = "order:delivery-events";

const COURIER_PENDING = ["COOKING", "READY", "ASSIGNING_COURIER"];

/**
 * События участников саги.
 *
 * Платежи: синхронный ответ — основной путь, событие — страховка. Если вызов
 * холдирования закончился таймаутом, а холд у провайдера прошёл, пришедший
 * позже `PaymentAuthorized` либо продолжит заказ, либо — если заказ уже
 * отменён — запустит снятие холда. Деньги не зависают ни в одном из исходов.
 *
 * Доставка сообщает факты (курьер найден, забрал, вручил), переход статуса
 * выполняет заказ: данные принадлежат ровно одному контексту.
 *
 * Защита от повторов (REL-4): отметка о сообщении пишется в inbox_messages
 * той же транзакцией, что и изменение. Повторная доставка того же события
 * упирается в первичный ключ и ничего не меняет.
 */
@Injectable()
export class ParticipantEventsUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_COMMITTER) private readonly committer: OrderCommitter,
    @Inject(ORDER_WORKFLOW) private readonly workflow: OrderWorkflow,
    @Inject(SAGA_SETTINGS) private readonly settings: SagaSettings,
  ) {}

  async onPaymentEvent(event: DomainEvent<PaymentEventBase>, now = new Date()): Promise<boolean> {
    const loaded = await this.orders.findById(event.payload?.orderId);
    if (!loaded) return false;
    const { order, saga } = loaded;
    const options: CommitOptions = {};

    switch (event.eventType) {
      case PAYMENT_EVENT_TYPES.authorized: {
        const payload = event.payload as PaymentAuthorizedPayload;
        saga.record({ paymentAuthorized: true, paymentId: payload.paymentId });
        if (order.status === "CREATED" || order.status === "PENDING_PAYMENT") {
          domain(() => {
            order.startPayment(now);
            order.markPaid(now);
          });
        } else if (order.status === "CANCELLED") {
          // Холд прошёл уже после отмены — снять его. Прежнее снятие могло
          // выполниться раньше, чем появился холд, поэтому снимается заново:
          // лишнее снятие безопасно, пропущенное — нет.
          saga.record({ paymentVoided: false });
          options.schedule = this.workflow.compensations(saga, now);
        }
        break;
      }
      case PAYMENT_EVENT_TYPES.failed: {
        const payload = event.payload as PaymentFailedPayload;
        if (payload.operation !== "AUTHORIZE" || order.status !== "PENDING_PAYMENT") return false;
        domain(() =>
          order.cancel(SYSTEM, "PAYMENT_FAILED", `платёж отклонён: ${payload.reason}`, now),
        );
        options.plan = { holdOutcomeKnown: true };
        break;
      }
      case PAYMENT_EVENT_TYPES.captured: {
        const payload = event.payload as PaymentCapturedPayload;
        if (saga.facts.paymentCaptured) return false;
        saga.record({ paymentCaptured: true, capturedAmount: payload.amount });
        if (order.status === "CANCELLED") options.schedule = this.workflow.compensations(saga, now);
        break;
      }
      case PAYMENT_EVENT_TYPES.voided:
        if (saga.facts.paymentVoided) return false;
        saga.record({ paymentVoided: true, defensiveVoidPending: false });
        break;
      case PAYMENT_EVENT_TYPES.refunded: {
        const payload = event.payload as PaymentRefundedPayload;
        if (payload.refundedTotal <= saga.facts.refundedAmount) return false;
        saga.record({ refundedAmount: payload.refundedTotal });
        break;
      }
      default:
        return false;
    }

    if (order.isTerminal && saga.status === "COMPENSATING" && saga.fullyCompensated) {
      saga.finishCompensation();
    }
    return this.commit(loaded, event, PAYMENT_CONSUMER, now, options);
  }

  async onDeliveryEvent(event: DomainEvent<DeliveryEventBase>, now = new Date()): Promise<boolean> {
    const loaded = await this.orders.findById(event.payload?.orderId);
    if (!loaded) return false;
    const { order, saga } = loaded;
    const options: CommitOptions = {};

    switch (event.eventType) {
      case DELIVERY_EVENT_TYPES.courierAssigned: {
        const payload = event.payload as CourierAssignedPayload;
        saga.record({ deliveryId: payload.deliveryId, courierId: payload.courierId });
        break;
      }
      case DELIVERY_EVENT_TYPES.courierAccepted: {
        const payload = event.payload as CourierAcceptedPayload;
        saga.record({ deliveryId: payload.deliveryId, courierId: payload.courierId });
        if (order.attentionReason?.includes("курьер")) order.clearAttention();
        break;
      }
      case DELIVERY_EVENT_TYPES.courierNotFound: {
        const payload = event.payload as CourierNotFoundPayload;
        if (!COURIER_PENDING.includes(order.status)) return false;
        // Свободных рядом нет: оператору — сигнал, саге — повтор вызова позже.
        // Автоотмены нет: еда уже готовится.
        order.flagAttention(`свободных курьеров рядом нет (попыток: ${payload.attempts})`, now);
        saga.record({ courierRequested: false });
        saga.nextSeq("courierSeq");
        options.schedule = [
          {
            type: SAGA_STEPS.requestCourier,
            fireAt: new Date(now.getTime() + this.settings.courierRetryDelayMs),
          },
        ];
        break;
      }
      case DELIVERY_EVENT_TYPES.orderPickedUp: {
        const payload = event.payload as OrderPickedUpPayload;
        saga.record({ courierId: payload.courierId });
        if (!domain(() => order.pickUp(payload.courierId, now))) return false;
        order.clearAttention();
        options.plan = { etaMinutes: payload.etaMinutes ?? null };
        break;
      }
      case DELIVERY_EVENT_TYPES.deliveryCompleted: {
        const payload = event.payload as DeliveryCompletedPayload;
        if (order.status === "COOKING" || order.status === "ASSIGNING_COURIER") {
          // Событие о вручении курьеру потерялось или пришло позже — порядок
          // внутри партиции это исключает, но заказ не должен застрять.
          domain(() => order.pickUp(payload.courierId, now));
        }
        if (!domain(() => order.deliver(payload.courierId, now))) return false;
        break;
      }
      default:
        return false;
    }

    return this.commit(loaded, event, DELIVERY_CONSUMER, now, options);
  }

  private async commit(
    loaded: LoadedOrder,
    event: DomainEvent,
    consumer: string,
    now: Date,
    options: CommitOptions,
  ): Promise<boolean> {
    try {
      await this.committer.commit(loaded, now, {
        ...options,
        inbox: { messageId: event.messageId, consumer, eventType: event.eventType },
      });
      return true;
    } catch (error) {
      if (error instanceof DuplicateMessageError) return false;
      throw error;
    }
  }
}
