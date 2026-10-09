import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DomainRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isAppError,
} from "@food-delivery/shared";
import type { ValidateCartResponse } from "@food-delivery/contracts";
import type { Requester } from "../access";
import { CART_STORE, type Cart, type CartLine, type CartStore } from "../ports/cart.store";
import { CATALOG_PORT, type CatalogPort } from "../ports/participants";
import { SAGA_SETTINGS, type SagaSettings } from "../saga/saga-settings";

const MAX_LINES = 50;
const MAX_QUANTITY = 99;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AddToCartInput {
  restaurantId: string;
  itemId: string;
  quantity: number;
  selections?: CartLine["selections"];
  /** Начать корзину заново, если в ней блюда другого ресторана (CART-4). */
  replaceRestaurant?: boolean;
}

export interface CartView {
  restaurantId: string | null;
  lines: CartLine[];
  /** Расчёт по адресу — если адрес передан и корзина не пуста. */
  pricing: {
    itemsAmount: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
  } | null;
  /** Почему корзину сейчас нельзя оформить: ниже минимума, вне зоны, ресторан закрыт. */
  problem: string | null;
}

/**
 * Корзина (CART-1..4).
 *
 * Корзина хранит только выбор клиента — блюдо, количество, модификаторы.
 * Цены в ней не хранятся: они считаются каталогом в момент показа и ещё раз
 * при оформлении. Иначе корзина, собранная вчера, оформилась бы по вчерашним
 * ценам.
 */
@Injectable()
export class CartUseCases {
  constructor(
    @Inject(CART_STORE) private readonly carts: CartStore,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(SAGA_SETTINGS) private readonly settings: SagaSettings,
  ) {}

  /** CART-2: корзина с расчётом итога по адресу. */
  async view(requester: Requester, at?: { latitude: number; longitude: number }) {
    this.assertClient(requester);
    const cart = (await this.carts.get(requester.id)) ?? this.empty(requester.id);
    return this.priced(cart, at);
  }

  /** CART-1: добавить блюдо. CART-4: только из одного ресторана. */
  async add(requester: Requester, input: AddToCartInput) {
    this.assertClient(requester);
    if (!UUID.test(input.itemId ?? "") || !UUID.test(input.restaurantId ?? "")) {
      throw new ValidationError("restaurantId и itemId должны быть UUID");
    }
    this.assertQuantity(input.quantity);

    let cart = (await this.carts.get(requester.id)) ?? this.empty(requester.id);
    if (cart.restaurantId && cart.restaurantId !== input.restaurantId && cart.lines.length > 0) {
      if (!input.replaceRestaurant) {
        throw new DomainRuleError(
          "в корзине блюда другого ресторана: оформите их или очистите корзину",
          {
            restaurantId: cart.restaurantId,
          },
        );
      }
      cart = this.empty(requester.id);
    }

    const selections = input.selections ?? [];
    const same = cart.lines.find(
      (line) => line.itemId === input.itemId && sameSelections(line.selections, selections),
    );
    if (same) {
      this.assertQuantity(same.quantity + input.quantity);
      same.quantity += input.quantity;
    } else {
      if (cart.lines.length >= MAX_LINES) {
        throw new DomainRuleError(`в корзине не больше ${MAX_LINES} позиций`);
      }
      cart.lines.push({
        lineId: randomUUID(),
        itemId: input.itemId,
        quantity: input.quantity,
        selections,
      });
    }
    cart.restaurantId = input.restaurantId;
    return this.store(cart);
  }

  /** CART-1: изменить количество; ноль — удалить позицию. */
  async setQuantity(requester: Requester, lineId: string, quantity: number) {
    this.assertClient(requester);
    const cart = await this.carts.get(requester.id);
    const line = cart?.lines.find((candidate) => candidate.lineId === lineId);
    if (!cart || !line) throw new NotFoundError("позиции нет в корзине", { lineId });
    if (quantity === 0) {
      cart.lines = cart.lines.filter((candidate) => candidate.lineId !== lineId);
    } else {
      this.assertQuantity(quantity);
      line.quantity = quantity;
    }
    return this.store(cart);
  }

  async remove(requester: Requester, lineId: string) {
    return this.setQuantity(requester, lineId, 0);
  }

  async clear(requester: Requester) {
    this.assertClient(requester);
    await this.carts.clear(requester.id);
    return this.priced(this.empty(requester.id));
  }

  private async store(cart: Cart) {
    cart.updatedAt = new Date().toISOString();
    if (cart.lines.length === 0) cart.restaurantId = null;
    await this.carts.save(cart);
    return this.priced(cart);
  }

  /**
   * Итог считает каталог (CART-2, CART-3). Если корзину сейчас оформить
   * нельзя — это не ошибка показа корзины, а её состояние: клиент видит
   * причину рядом с итогом.
   */
  private async priced(
    cart: Cart,
    at?: { latitude: number; longitude: number },
  ): Promise<CartView> {
    const view: CartView = {
      restaurantId: cart.restaurantId,
      lines: cart.lines,
      pricing: null,
      problem: null,
    };
    if (!at || !cart.restaurantId || cart.lines.length === 0) return view;

    let quote: ValidateCartResponse;
    try {
      quote = await this.catalog.validateCart(cart.restaurantId, {
        latitude: at.latitude,
        longitude: at.longitude,
        items: cart.lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity,
          selections: line.selections,
        })),
      });
    } catch (error) {
      if (isAppError(error) && !error.retryable) return { ...view, problem: error.message };
      throw error;
    }
    const serviceFee = this.settings.serviceFee;
    return {
      ...view,
      pricing: {
        itemsAmount: quote.itemsAmount,
        deliveryFee: quote.deliveryFee,
        serviceFee,
        total: quote.itemsAmount + quote.deliveryFee + serviceFee,
      },
    };
  }

  private empty(customerId: string): Cart {
    return { customerId, restaurantId: null, lines: [], updatedAt: new Date().toISOString() };
  }

  private assertQuantity(quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new ValidationError(`количество должно быть целым числом от 1 до ${MAX_QUANTITY}`);
    }
  }

  private assertClient(requester: Requester) {
    if (!requester.roles.includes("client")) throw new ForbiddenError("корзина — для клиента");
  }
}

function sameSelections(a: CartLine["selections"], b: CartLine["selections"]): boolean {
  const key = (selections: CartLine["selections"]) =>
    JSON.stringify(
      [...selections]
        .map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds].sort() }))
        .sort((x, y) => x.groupId.localeCompare(y.groupId)),
    );
  return key(a) === key(b);
}
