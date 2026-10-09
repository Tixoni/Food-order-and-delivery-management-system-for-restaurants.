import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import { CurrentUser, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { OrderCommandsUseCase } from "../../application/use-cases/order-commands.use-case";
import { OrderQueriesUseCase } from "../../application/use-cases/order-queries.use-case";
import {
  PlaceOrderUseCase,
  type PlaceOrderInput,
} from "../../application/use-cases/place-order.use-case";
import { ORDER_READ_MODEL, type OrderReadModel } from "../../application/ports/order-read-model";
import { optionalNumber, requesterOf } from "./requester";

/**
 * Заказы клиента: оформление, просмотр, история, отмена.
 *
 * Слой интерфейса только принимает запрос и отдаёт представление. Права
 * проверяются в сценариях — там, где известен заказ и его владелец (SEC-2).
 */
@Controller("orders")
export class OrdersController {
  constructor(
    private readonly place: PlaceOrderUseCase,
    private readonly commands: OrderCommandsUseCase,
    private readonly queries: OrderQueriesUseCase,
    @Inject(ORDER_READ_MODEL) private readonly read: OrderReadModel,
  ) {}

  /**
   * ORD-1, ORD-4: оформление. Повтор с тем же ключом идемпотентности
   * возвращает прежний заказ с кодом 200, новый заказ — с кодом 201.
   */
  @Roles(ROLES.client)
  @Post()
  async placeOrder(
    @Body() body: PlaceOrderInput,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    if (!body || typeof body !== "object") throw new ValidationError("пустой запрос");
    const { order, replayed } = await this.place.execute(body, requesterOf(user));
    response.status(replayed ? 200 : 201);
    return { replayed, order: await this.read.get(order.id) };
  }

  /** ORD-7: история заказов клиента. */
  @Roles(ROLES.client)
  @Get()
  async mine(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const items = await this.queries.listMine(
      requesterOf(user),
      optionalNumber(limit),
      optionalNumber(offset),
    );
    return { items };
  }

  /** TRK-1: заказ целиком — клиенту свой, кухне своего ресторана, оператору любой. */
  @Get(":orderId")
  async get(@Param("orderId") orderId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.queries.get(orderId, requesterOf(user));
  }

  /** ADM-3: история переходов; оператору — ещё шаги саги и ожидающие таймеры. */
  @Get(":orderId/history")
  async history(@Param("orderId") orderId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.queries.history(orderId, requesterOf(user));
  }

  /** ORD-5: отмена клиентом до начала готовки. */
  @Roles(ROLES.client)
  @HttpCode(200)
  @Post(":orderId/cancel")
  async cancel(
    @Param("orderId") orderId: string,
    @Body() body: { reason?: string } | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    await this.commands.cancelByCustomer(orderId, requesterOf(user), body?.reason ?? null);
    return this.read.get(orderId);
  }
}
