import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  ValidationError,
  getCorrelationId,
} from "@food-delivery/shared";
import type { ValidateCartResponse } from "@food-delivery/contracts";
import { CheckoutSaga } from "../../domain/checkout-saga";
import { geoPoint } from "../../domain/geo-point";
import { Order } from "../../domain/order";
import { OrderLine } from "../../domain/order-line";
import type { Requester } from "../access";
import { domain } from "../domain-errors";
import { CART_STORE, type CartStore } from "../ports/cart.store";
import {
  DuplicateOrderError,
  ORDER_REPOSITORY,
  type OrderRepository,
} from "../ports/order.repository";
import { CATALOG_PORT, type CatalogPort } from "../ports/participants";
import { ORDER_WORKFLOW, type OrderWorkflow } from "../saga/order-workflow";
import { SAGA_SETTINGS, type SagaSettings } from "../saga/saga-settings";

export interface PlaceOrderInput {
  restaurantId: string;
  /** Ключ идемпотентности от клиента: повтор формы — тот же заказ (ORD-4). */
  idempotencyKey: string;
  address: { text: string; latitude: number; longitude: number };
  contactPhone?: string | null;
  comment?: string | null;
  /** Позиции. Если не переданы — берутся из корзины клиента. */
  items?: Array<{
    itemId: string;
    quantity: number;
    selections?: Array<{ groupId: string; optionIds: string[] }>;
  }>;
}

export interface PlaceOrderResult {
  order: Order;
  /** Заказ с этим ключом уже был: возвращён прежний, новый не создан. */
  replayed: boolean;
}

/**
 * Оформление заказа (ORD-1, ORD-2, ORD-4) — шаги 1 и 2 саги.
 *
 * В запросе пользователя выполняется только то, без чего нельзя ответить:
 * проверка корзины в каталоге (цены, наличие, часы работы, зона доставки)
 * и создание заказа. Холдирование средств — уже следующий шаг саги,
 * его выполняет фоновый исполнитель. Поэтому отказ платёжного сервиса
 * не мешает принимать заказы (REL-2), а ответ укладывается в PERF-2.
 *
 * Идемпотентность — уникальным индексом, а не проверкой «сначала выбрать»:
 * два одновременных повтора пройдут проверку оба, а индекс пропустит один.
 */
@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(CART_STORE) private readonly carts: CartStore,
    @Inject(ORDER_WORKFLOW) private readonly workflow: OrderWorkflow,
    @Inject(SAGA_SETTINGS) private readonly settings: SagaSettings,
  ) {}

  async execute(
    input: PlaceOrderInput,
    requester: Requester,
    now = new Date(),
  ): Promise<PlaceOrderResult> {
    if (!requester.roles.includes("client")) {
      throw new ForbiddenError("оформить заказ может только клиент");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
      throw new ValidationError("не передан ключ идемпотентности idempotencyKey");
    }
    if (!input.address || typeof input.address.text !== "string") {
      throw new ValidationError("не указан адрес доставки");
    }

    // Повтор формы: прежний заказ, без повторной проверки корзины.
    const existing = await this.orders.findByIdempotencyKey(requester.id, input.idempotencyKey);
    if (existing) return this.replay(existing, input);

    const location = domain(() => geoPoint(input.address.latitude, input.address.longitude));
    const fromCart = !input.items;
    const items = input.items ?? (await this.cartItems(requester.id, input.restaurantId));
    if (items.length === 0) throw new ValidationError("в заказе нет позиций");

    // Цены, наличие и зона — только по ответу каталога, на сервере,
    // непосредственно перед созданием заказа (а не по кэшу шлюза).
    const quote = await this.catalog.validateCart(input.restaurantId, {
      latitude: location.latitude,
      longitude: location.longitude,
      items,
    });
    const lines = this.toLines(quote);

    const orderNumber = await this.orders.nextOrderNumber();
    const order = domain(() =>
      Order.place(
        {
          id: randomUUID(),
          orderNumber,
          customerId: requester.id,
          restaurantId: input.restaurantId,
          idempotencyKey: input.idempotencyKey,
          addressText: input.address.text,
          location,
          pickup: quote.pickup,
          contactPhone: input.contactPhone ?? null,
          lines,
          deliveryFee: quote.deliveryFee,
          serviceFee: this.settings.serviceFee,
          comment: input.comment ?? null,
        },
        now,
      ),
    );
    const saga = CheckoutSaga.start(randomUUID(), order.id, getCorrelationId());
    const history = order.pullChanges();
    const plan = this.workflow.plan(order, saga, history, now);

    try {
      await this.orders.create({
        order,
        saga,
        history,
        events: plan.events,
        schedule: plan.schedule,
      });
    } catch (error) {
      if (!(error instanceof DuplicateOrderError)) throw error;
      // Два одновременных повтора: индекс пропустил другой — отдаём его заказ.
      const winner = await this.orders.findByIdempotencyKey(requester.id, input.idempotencyKey);
      if (!winner) throw error;
      return this.replay(winner, input);
    }

    // Корзина больше не нужна. Её очистка не должна ломать оформление:
    // кэш недоступен — корзина истечёт сама.
    if (fromCart) await this.carts.clear(requester.id).catch(() => undefined);
    return { order, replayed: false };
  }

  private replay(existing: Order, input: PlaceOrderInput): PlaceOrderResult {
    if (existing.restaurantId !== input.restaurantId) {
      throw new ConflictError("этот ключ идемпотентности уже использован для другого заказа");
    }
    return { order: existing, replayed: true };
  }

  private async cartItems(customerId: string, restaurantId: string) {
    const cart = await this.carts.get(customerId);
    if (!cart || cart.lines.length === 0) throw new ValidationError("корзина пуста");
    if (cart.restaurantId !== restaurantId) {
      throw new ValidationError("в корзине блюда другого ресторана");
    }
    return cart.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      selections: line.selections,
    }));
  }

  /**
   * Снимки позиций из ответа каталога. Итог позиции пересчитывается здесь
   * же и сверяется с каталогом: расхождение означает рассогласование
   * контракта, и принимать такой заказ нельзя — чек не сойдётся.
   */
  private toLines(quote: ValidateCartResponse): OrderLine[] {
    const lines = quote.lines.map((line) =>
      domain(() =>
        OrderLine.create({
          menuItemId: line.itemId,
          name: line.name,
          basePrice: line.basePrice,
          quantity: line.quantity,
          options: line.chosenOptions.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            priceDelta: option.priceDelta,
          })),
        }),
      ),
    );
    const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const mismatch = lines.some((line, index) => line.lineTotal !== quote.lines[index]!.lineTotal);
    if (mismatch || total !== quote.itemsAmount) {
      throw new InternalError("расчёт каталога не сходится с позициями заказа", {
        catalogTotal: quote.itemsAmount,
        orderTotal: total,
      });
    }
    return lines;
  }
}
