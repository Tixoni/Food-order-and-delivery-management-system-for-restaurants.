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
import { ForbiddenError, ValidationError } from "@food-delivery/shared";
import { ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import type { RestaurantView } from "../catalog/catalog.views";
import { OrderClient } from "../order/order.client";
import type { OrderView } from "../order/order.views";
import { Restaurant } from "./catalog.models";
import { AccessToken, GqlUser } from "./gql.decorators";
import { Order, OrderTransition, PlaceOrderInput, PlaceOrderResult } from "./order.models";
import { RestaurantLookup, type LookupContext } from "./restaurant-lookup";

const MAX_COMMENT = 500;

/** Представление сервиса заказов → тип схемы. */
const toOrder = (view: OrderView): Order => ({
  ...view,
  canCancel: view.customerCanCancel ?? false,
});

/**
 * Заказы: клиенту — оформление, история, отслеживание, отмена;
 * кухне — очередь и команды (KIT-1..4).
 *
 * Шлюз здесь делает то, ради чего он BFF: склеивает ответы двух сервисов
 * в один ответ экрану. Заказ приходит из `order`, название ресторана —
 * из `catalog`; клиентское приложение делает один запрос вместо двух.
 */
@Resolver(() => Order)
export class OrderResolver {
  constructor(
    private readonly orders: OrderClient,
    private readonly restaurants: RestaurantLookup,
  ) {}

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

  /* ─────────────── Кухня (KIT-1..4) ─────────────── */

  /**
   * KIT-1: очередь кухни. Ресторан — из токена сотрудника: кухня видит
   * только свой ресторан; администратору — любой, по аргументу.
   */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Query(() => [Order], { description: "Очередь кухни: принять, готовить, отдать (KIT-1)" })
  async kitchenQueue(
    @Args("restaurantId", { type: () => ID, nullable: true }) restaurantId?: string,
    @GqlUser() user?: AuthenticatedUser,
    @AccessToken() token?: string,
  ): Promise<Order[]> {
    const target = restaurantOf(user, restaurantId);
    return (await this.orders.kitchenQueue(token, target)).map(toOrder);
  }

  /** KIT-2: принять заказ и назвать время готовки. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Mutation(() => Order, { description: "Принять заказ с временем готовки (KIT-2)" })
  async confirmOrder(
    @Args("id", { type: () => ID }) id: string,
    @Args("cookingMinutes", { type: () => Int }) cookingMinutes: number,
    @AccessToken() token?: string,
  ): Promise<Order> {
    return toOrder(await this.orders.kitchenCommand(token, id, "confirm", { cookingMinutes }));
  }

  /** KIT-3: отклонить с причиной; холд снимется. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Mutation(() => Order, { description: "Отклонить заказ с причиной (KIT-3)" })
  async rejectOrder(
    @Args("id", { type: () => ID }) id: string,
    @Args("reason") reason: string,
    @AccessToken() token?: string,
  ): Promise<Order> {
    if (reason.length > MAX_COMMENT) throw new ValidationError("причина длиннее 500 символов");
    return toOrder(await this.orders.kitchenCommand(token, id, "reject", { reason }));
  }

  /** KIT-4: заказ готов к выдаче курьеру. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Mutation(() => Order, { description: "Заказ готов к выдаче (KIT-4)" })
  async markOrderReady(
    @Args("id", { type: () => ID }) id: string,
    @AccessToken() token?: string,
  ): Promise<Order> {
    return toOrder(await this.orders.kitchenCommand(token, id, "ready"));
  }

  @ResolveField(() => Restaurant, { nullable: true })
  restaurant(
    @Parent() order: Order,
    @Context() context: LookupContext,
  ): Promise<RestaurantView | null> {
    return this.restaurants.find(order.restaurantId, context);
  }
}

/** Ресторан сотрудника — из токена; администратор указывает его сам. */
export function restaurantOf(user: AuthenticatedUser | undefined, requested?: string): string {
  if (user?.roles.includes("admin") && requested) return requested;
  const own = user?.restaurantId;
  if (!own) throw new ForbiddenError("учётная запись не привязана к ресторану");
  if (requested && requested !== own) {
    throw new ForbiddenError("очередь доступна только кухне своего ресторана");
  }
  return own;
}
