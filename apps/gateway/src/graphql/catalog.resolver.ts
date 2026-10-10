import { Args, Float, ID, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { NotFoundError, ValidationError } from "@food-delivery/shared";
import { Public, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { CatalogCache } from "../catalog/catalog.cache";
import { CatalogClient } from "../catalog/catalog.client";
import { AccessToken, GqlUser } from "./gql.decorators";
import {
  AvailabilityResult,
  CurrentUserView,
  Menu,
  Restaurant,
  RestaurantOffer,
  RestaurantPage,
  StopListEntry,
} from "./catalog.models";

/**
 * Единая точка входа для клиентских приложений.
 *
 * Шлюз не содержит правил предметной области: он обращается к каталогу,
 * складывает ответ для экрана и кэширует то, что читают чаще, чем меняют.
 * Любое правило, оказавшееся здесь, оказалось бы в системе дважды.
 *
 * Права проверяются дважды, и это не избыточность: здесь — чтобы не ходить
 * в каталог заведомо зря, там — потому что владелец данных обязан проверять
 * их сам (SEC-2). Обращение к каталогу мимо шлюза не даёт обойти проверку.
 */
@Resolver()
export class CatalogResolver {
  constructor(
    private readonly catalog: CatalogClient,
    private readonly cache: CatalogCache,
  ) {}

  /** Список ресторанов. Открыт без входа: витрину видно до регистрации. */
  @Public()
  @Query(() => RestaurantPage, { description: "Список действующих ресторанов" })
  async restaurants(
    @Args("page", { type: () => Int, defaultValue: 1 }) page: number,
    @Args("pageSize", { type: () => Int, defaultValue: 20 }) pageSize: number,
    @AccessToken() token?: string,
  ): Promise<RestaurantPage> {
    return this.cache.through(`gateway:restaurants:${page}:${pageSize}`, () =>
      this.catalog.listRestaurants(token, page, pageSize),
    );
  }

  /** CAT-1: рестораны, доставляющие по адресу клиента. */
  @Public()
  @Query(() => [RestaurantOffer], { description: "Рестораны, доставляющие по адресу (CAT-1)" })
  async restaurantsNearby(
    @Args("latitude", { type: () => Float }) latitude: number,
    @Args("longitude", { type: () => Float }) longitude: number,
    @Args("limit", { type: () => Int, defaultValue: 50 }) limit: number,
    @AccessToken() token?: string,
  ): Promise<RestaurantOffer[]> {
    // Координаты округляются до пяти знаков — это примерно метр. Без
    // округления ключ кэша был бы у каждого запроса свой: браузер отдаёт
    // координаты с точностью, которой не существует на практике.
    const key = `gateway:nearby:${latitude.toFixed(5)}:${longitude.toFixed(5)}:${limit}`;

    const result = await this.cache.through(key, () =>
      this.catalog.deliveringTo(token, latitude, longitude, limit),
    );

    return result.items;
  }

  /** Один ресторан — для прямой ссылки на меню. Неизвестный — `null`. */
  @Public()
  @Query(() => Restaurant, { nullable: true, description: "Ресторан по идентификатору" })
  async restaurant(
    @Args("id", { type: () => ID }) id: string,
    @AccessToken() token?: string,
  ): Promise<Restaurant | null> {
    try {
      return await this.cache.through(this.cache.restaurantKey(id, "summary"), () =>
        this.catalog.restaurant(token, id),
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** CAT-2: меню ресторана. */
  @Public()
  @Query(() => Menu, { description: "Меню ресторана, сгруппированное по категориям (CAT-2)" })
  async menu(
    @Args("restaurantId", { type: () => ID }) restaurantId: string,
    @Args("includeUnavailable", { type: () => Boolean, defaultValue: false })
    includeUnavailable: boolean,
    @AccessToken() token?: string,
  ): Promise<Menu> {
    // Меню для сотрудника ресторана не кэшируется: оно содержит блюда
    // из стоп-листа, меняется как раз при работе с ними и запрашивается
    // несоизмеримо реже клиентского.
    if (includeUnavailable) {
      return this.catalog.menu(token, restaurantId, true) as Promise<Menu>;
    }

    return this.cache.through(this.cache.restaurantKey(restaurantId, "menu"), () =>
      this.catalog.menu(token, restaurantId, false),
    ) as Promise<Menu>;
  }

  /** История стоп-листа — для панели менеджера и кухни. */
  @Roles(ROLES.manager, ROLES.kitchen, ROLES.admin)
  @Query(() => [StopListEntry], { description: "История стоп-листа ресторана" })
  async stopList(
    @Args("restaurantId", { type: () => ID }) restaurantId: string,
    @Args("limit", { type: () => Int, defaultValue: 50 }) limit: number,
    @AccessToken() token?: string,
  ): Promise<StopListEntry[]> {
    const result = await this.catalog.stopList(token, restaurantId, limit);
    return result.entries;
  }

  @Query(() => CurrentUserView, { nullable: true, description: "Кто вошёл в систему" })
  async me(@GqlUser() user?: AuthenticatedUser): Promise<CurrentUserView | null> {
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: [...user.roles],
      restaurantId: user.restaurantId,
    };
  }

  /**
   * CAT-4: перевод блюда в стоп-лист и обратно.
   *
   * Кэш шлюза сбрасывается событием из брокера. Все реплики используют
   * один Redis, поэтому сброс виден каждой из них (SCAL-2).
   */
  @Roles(ROLES.manager, ROLES.kitchen, ROLES.admin)
  @Mutation(() => AvailabilityResult, {
    description: "Убрать блюдо из продажи или вернуть (CAT-4)",
  })
  async setMenuItemAvailability(
    @Args("itemId", { type: () => ID }) itemId: string,
    @Args("restaurantId", { type: () => ID }) restaurantId: string,
    @Args("isAvailable", { type: () => Boolean }) isAvailable: boolean,
    @Args("reason", { type: () => String, nullable: true }) reason?: string,
    @AccessToken() token?: string,
  ): Promise<AvailabilityResult> {
    if (reason !== undefined && reason !== null && reason.trim().length > 500) {
      throw new ValidationError("причина длиннее 500 символов");
    }

    const result = await this.catalog.setAvailability(token, itemId, {
      restaurantId,
      isAvailable,
      reason: reason ?? null,
    });

    return {
      itemId: result.item.id,
      isAvailable: result.item.isAvailable,
      changed: result.changed,
    };
  }
}
