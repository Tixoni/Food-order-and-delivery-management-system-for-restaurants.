import {
  Args,
  Context,
  ID,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "@nestjs/graphql";
import { ValidationError, createLogger, type Logger } from "@food-delivery/shared";
import { ROLES, Roles } from "@food-delivery/service-kit";
import { Inject } from "@nestjs/common";
import { CatalogCache } from "../catalog/catalog.cache";
import { CatalogClient } from "../catalog/catalog.client";
import type { RestaurantView } from "../catalog/catalog.views";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import { OrderClient } from "../order/order.client";
import type { OrderView } from "../order/order.views";
import { Restaurant } from "./catalog.models";
import { AccessToken } from "./gql.decorators";
import { Order, OrderTransition, PlaceOrderInput, PlaceOrderResult } from "./order.models";

/** Контекст одного запроса GraphQL: здесь живёт кэш ресторанов этого запроса. */
interface RequestContext {
  restaurants?: Map<string, Promise<RestaurantView | null>>;
}

const MAX_COMMENT = 500;

/** Представление сервиса заказов → тип схемы. */
const toOrder = (view: OrderView): Order => ({
  ...view,
  canCancel: view.customerCanCancel ?? false,
});

/**
 * Заказы клиента: оформление, история, отслеживание, отмена.
 *
 * Шлюз здесь делает то, ради чего он BFF: склеивает ответы двух сервисов
 * в один ответ экрану. Заказ приходит из `order`, название ресторана —
 * из `catalog`; клиентское приложение делает один запрос вместо двух.
 * Если каталог недоступен, заказ всё равно отдаётся — без названия
 * ресторана: экран отслеживания важнее подписи на нём (REL-2).
 */
@Resolver(() => Order)
export class OrderResolver {
  private readonly logger: Logger;

  constructor(
    private readonly orders: OrderClient,
    private readonly catalog: CatalogClient,
    private readonly cache: CatalogCache,
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
  ) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "order-resolver",
    });
  }

  /** ORD-1, ORD-4: оформление заказа из корзины. */
  @Roles(ROLES.client)
  @Mutation(() => PlaceOrderResult, { description: "Оформить заказ (ORD-1, ORD-4)" })
  async placeOrder(
    @Args("input") input: PlaceOrderInput,
    @AccessToken() token?: string,
  ): Promise<PlaceOrderResult> {
    if (input.comment && input.comment.length > MAX_COMMENT) {
      throw new ValidationError(`комментарий длиннее ${MAX_COMMENT} символов`);
    }
    const result = await this.orders.place(token, {
      restaurantId: input.restaurantId,
      idempotencyKey: input.idempotencyKey,
      address: input.address,
      contactPhone: input.contactPhone ?? null,
      comment: input.comment ?? null,
      items: input.items.map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
        ...(item.selections ? { selections: item.selections } : {}),
      })),
    });
    return { replayed: result.replayed, order: toOrder(result.order) };
  }

  /** ORD-7: история заказов клиента, новые сверху. */
  @Roles(ROLES.client)
  @Query(() => [Order], { description: "Мои заказы (ORD-7)" })
  async myOrders(
    @Args("limit", { type: () => Int, defaultValue: 20 }) limit: number,
    @Args("offset", { type: () => Int, defaultValue: 0 }) offset: number,
    @AccessToken() token?: string,
  ): Promise<Order[]> {
    return (await this.orders.mine(token, limit, offset)).map(toOrder);
  }

  /** TRK-1: заказ целиком. Чужой заказ сервис заказов не отдаст. */
  @Query(() => Order, { description: "Заказ по идентификатору (TRK-1)" })
  async order(
    @Args("id", { type: () => ID }) id: string,
    @AccessToken() token?: string,
  ): Promise<Order> {
    return toOrder(await this.orders.get(token, id));
  }

  /** Шкала статусов на экране отслеживания. */
  @Query(() => [OrderTransition], { description: "Переходы статусов заказа" })
  async orderTransitions(
    @Args("id", { type: () => ID }) id: string,
    @AccessToken() token?: string,
  ): Promise<OrderTransition[]> {
    return this.orders.transitions(token, id);
  }

  /** ORD-5: отмена клиентом до начала готовки. */
  @Roles(ROLES.client)
  @Mutation(() => Order, { description: "Отменить заказ до начала готовки (ORD-5)" })
  async cancelOrder(
    @Args("id", { type: () => ID }) id: string,
    @Args("reason", { type: () => String, nullable: true }) reason?: string,
    @AccessToken() token?: string,
  ): Promise<Order> {
    if (reason && reason.length > MAX_COMMENT) {
      throw new ValidationError(`причина длиннее ${MAX_COMMENT} символов`);
    }
    return toOrder(await this.orders.cancel(token, id, reason ?? null));
  }

  /**
   * Ресторан заказа. В истории двадцать заказов чаще всего из двух-трёх
   * ресторанов: в пределах одного запроса каждый ресторан запрашивается
   * один раз, между запросами — берётся из общего кэша каталога.
   */
  @ResolveField(() => Restaurant, { nullable: true })
  restaurant(
    @Parent() order: Order,
    @Context() context: RequestContext,
  ): Promise<RestaurantView | null> {
    context.restaurants ??= new Map();
    let pending = context.restaurants.get(order.restaurantId);
    if (!pending) {
      pending = this.cache
        .through(this.cache.restaurantKey(order.restaurantId, "summary"), () =>
          this.catalog.restaurant(undefined, order.restaurantId),
        )
        .catch((error: unknown) => {
          this.logger.warn("ресторан заказа не получен из каталога", {
            restaurantId: order.restaurantId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      context.restaurants.set(order.restaurantId, pending);
    }
    return pending;
  }
}
