import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { CurrentUser, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { OrderCommandsUseCase } from "../../application/use-cases/order-commands.use-case";
import { OrderQueriesUseCase } from "../../application/use-cases/order-queries.use-case";
import { ORDER_READ_MODEL, type OrderReadModel } from "../../application/ports/order-read-model";
import { requesterOf } from "./requester";

/** Экран кухни: очередь заказов ресторана и команды над ними (KIT-1..4). */
@Controller()
export class KitchenController {
  constructor(
    private readonly commands: OrderCommandsUseCase,
    private readonly queries: OrderQueriesUseCase,
    @Inject(ORDER_READ_MODEL) private readonly read: OrderReadModel,
  ) {}

  /** KIT-1: заказы, которые нужно принять, готовить или отдать курьеру. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @Get("restaurants/:restaurantId/kitchen-queue")
  async queue(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return { items: await this.queries.kitchenQueue(restaurantId, requesterOf(user)) };
  }

  /** KIT-2: принять заказ и назвать время готовки. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @HttpCode(200)
  @Post("orders/:orderId/confirm")
  async confirm(
    @Param("orderId") orderId: string,
    @Body() body: { cookingMinutes?: number } | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    await this.commands.confirm(orderId, requesterOf(user), Number(body?.cookingMinutes));
    return this.read.get(orderId);
  }

  /** KIT-3: отклонить заказ с причиной. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @HttpCode(200)
  @Post("orders/:orderId/reject")
  async reject(
    @Param("orderId") orderId: string,
    @Body() body: { reason?: string } | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    await this.commands.reject(orderId, requesterOf(user), body?.reason ?? "");
    return this.read.get(orderId);
  }

  /** KIT-4: заказ готов к выдаче. */
  @Roles(ROLES.kitchen, ROLES.manager, ROLES.admin)
  @HttpCode(200)
  @Post("orders/:orderId/ready")
  async ready(@Param("orderId") orderId: string, @CurrentUser() user?: AuthenticatedUser) {
    await this.commands.markReady(orderId, requesterOf(user));
    return this.read.get(orderId);
  }
}
