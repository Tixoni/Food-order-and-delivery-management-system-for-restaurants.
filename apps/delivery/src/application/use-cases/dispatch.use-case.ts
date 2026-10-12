import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  ReleaseCourierRequest,
  ReleaseCourierResponse,
  RequestCourierRequest,
  RequestCourierResponse,
} from "@food-delivery/contracts";
import { ValidationError, getCorrelationId, runWithContext } from "@food-delivery/shared";
import { Delivery, Offer } from "../../domain/delivery";
import { geoPoint } from "../../domain/geo";
import { deliveryEvents } from "../delivery-events";
import { DISPATCH_SETTINGS, type DispatchSettings } from "../dispatch-settings";
import { domainCall } from "../errors";
import {
  DELIVERY_REPOSITORY,
  DuplicateDeliveryError,
  type DeliveryRepository,
} from "../ports/delivery.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OfferOutcome = "offered" | "not-found" | "skipped";

/**
 * Подбор курьера (DLV-3, DLV-4) — внутренний API для `order` и фоновый подбор.
 *
 * Триггер подбора один — команда `RequestCourier` от оркестратора: она
 * приходит после подтверждения рестораном, параллельно с готовкой, чтобы
 * курьер ехал к ресторану, пока еда готовится. Событие `OrderCooking`
 * подбор не запускает: два триггера без общего ключа дали бы двойное
 * назначение.
 *
 * Предложения уходят курьерам по очереди, от ближнего к дальнему. Отказ
 * или молчание 90 с — следующему; кандидаты кончились — событие
 * `CourierNotFound`, решение за `order` (он повторит запрос позже
 * с новым ключом, а оператору поднимет флаг).
 */
@Injectable()
export class DispatchUseCase {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(DISPATCH_SETTINGS) private readonly settings: DispatchSettings,
  ) {}

  async requestCourier(
    request: RequestCourierRequest,
    now = new Date(),
  ): Promise<RequestCourierResponse> {
    validateRequest(request);

    const result = await domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const existing = await tx.activeDeliveryByOrder(request.orderId);
        if (existing) {
          // Тот же ключ — повтор вызова: прежний ответ, поиск не перезапускается.
          if (existing.snapshot.requestKey === request.idempotencyKey) {
            return { delivery: existing, search: false };
          }
          // Новый ключ — оркестратор повторяет запрос после «не найден».
          existing.requestedAgain(request.idempotencyKey, now);
          await tx.saveDelivery(existing);
          return { delivery: existing, search: existing.status === "PENDING" };
        }

        const delivery = Delivery.open({
          id: randomUUID(),
          orderId: request.orderId,
          restaurantId: request.restaurantId,
          customerId: request.customerId ?? null,
          orderNumber: request.orderNumber ?? null,
          dropoffAddress: request.dropoffAddress?.slice(0, 500) ?? null,
          contactPhone: request.contactPhone?.slice(0, 32) ?? null,
          pickup: geoPoint(request.pickup.latitude, request.pickup.longitude),
          dropoff: geoPoint(request.dropoff.latitude, request.dropoff.longitude),
          readyAt: request.readyAt ? new Date(request.readyAt) : null,
          requestKey: request.idempotencyKey,
          correlationId: getCorrelationId(),
          now,
        });
        await tx.insertDelivery(delivery);
        return { delivery, search: true };
      }),
    ).catch(async (error) => {
      // Одновременный повтор успел создать доставку — отвечаем ею.
      if (!(error instanceof DuplicateDeliveryError)) throw error;
      return this.requestCourier(request, now);
    });

    if ("deliveryId" in result) return result;
    if (result.search) await this.offerNext(result.delivery.id, now);
    const status = result.delivery.status === "PENDING" ? "PENDING" : "ASSIGNED";
    return { deliveryId: result.delivery.id, status };
  }

  /**
   * Компенсация шага саги: заказ отменён — доставка закрывается, курьер
   * свободен, открытое предложение снимается. Без доставки — `released: false`.
   */
  async releaseCourier(
    request: ReleaseCourierRequest,
    now = new Date(),
  ): Promise<ReleaseCourierResponse> {
    if (!UUID.test(request?.orderId ?? "")) {
      throw new ValidationError("orderId: нужен идентификатор заказа");
    }
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const delivery = await tx.activeDeliveryByOrder(request.orderId);
        if (!delivery || !delivery.cancel(now)) return { released: false };
        await tx.saveDelivery(delivery);

        const offer = await tx.openOfferOf(delivery.id);
        if (offer) {
          offer.cancel(now);
          await tx.saveOffer(offer);
        }
        const courierId = delivery.snapshot.courierId ?? offer?.snapshot.courierId;
        if (courierId) {
          const courier = await tx.courierById(courierId);
          if (courier) {
            courier.free();
            await tx.saveCourier(courier);
          }
        }
        return { released: true };
      }),
    );
  }

  /**
   * Предложить заказ следующему кандидату. Безопасно вызывать сколько угодно
   * раз и с разных экземпляров: пока открыто предложение или заказ принят,
   * вызов ничего не делает.
   */
  async offerNext(deliveryId: string, now = new Date()): Promise<OfferOutcome> {
    return domainCall(() =>
      this.deliveries.transaction(async (tx) => {
        const delivery = await tx.deliveryById(deliveryId);
        if (!delivery || delivery.status !== "PENDING") return "skipped";
        if (await tx.openOfferOf(delivery.id)) return "skipped";

        return runWithContext(
          { correlationId: delivery.snapshot.correlationId ?? getCorrelationId() },
          async (): Promise<OfferOutcome> => {
            const sent = await tx.offersCount(delivery.id);
            const candidate = await tx.nearestCandidate(
              delivery,
              this.settings.radiusMeters,
              this.settings.freshSeconds,
            );

            if (!candidate) {
              // Сообщаем один раз на поиск: повторный вызов до нового запроса
              // от order не плодит одинаковых событий.
              if (delivery.snapshot.notFoundAt) return "skipped";
              delivery.notFound(now);
              await tx.saveDelivery(delivery);
              await tx.enqueue(
                [deliveryEvents.courierNotFound(delivery, sent, now)],
                delivery.snapshot.orderId,
              );
              return "not-found";
            }

            const offer = Offer.make({
              id: randomUUID(),
              deliveryId: delivery.id,
              courierId: candidate.courier.id,
              sequence: sent + 1,
              now,
              ttlSeconds: this.settings.offerTtlSeconds,
            });
            candidate.courier.offer();
            await tx.saveCourier(candidate.courier);
            await tx.insertOffer(offer);
            await tx.enqueue(
              [deliveryEvents.courierAssigned(delivery, candidate.courier.id, now)],
              delivery.snapshot.orderId,
            );
            return "offered";
          },
        );
      }),
    );
  }

  /**
   * DLV-4: молчание курьера дольше срока — предложение закрывается,
   * курьер возвращается в подбор, заказ уходит следующему. Срок хранится
   * в базе, поэтому перезапуск сервиса таймер не теряет.
   */
  async expireOffers(now = new Date(), limit = 20): Promise<number> {
    const expired = await this.deliveries.transaction(async (tx) => {
      const due = await tx.dueOffers(now, limit);
      for (const offer of due) {
        offer.expire(now);
        await tx.saveOffer(offer);
        const courier = await tx.courierById(offer.snapshot.courierId);
        if (courier) {
          courier.declineOffer();
          await tx.saveCourier(courier);
        }
      }
      return due.map((offer) => offer.snapshot.deliveryId);
    });

    for (const deliveryId of expired) await this.offerNext(deliveryId, now);
    return expired.length;
  }
}

function validateRequest(request: RequestCourierRequest): void {
  if (!UUID.test(request?.orderId ?? "")) {
    throw new ValidationError("orderId: нужен идентификатор заказа");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim() === "") {
    throw new ValidationError("idempotencyKey: нужен ключ идемпотентности");
  }
  if (!request.pickup || !request.dropoff) {
    throw new ValidationError("нужны точки выдачи и доставки");
  }
}
