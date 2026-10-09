import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  CurrentUser,
  Public,
  ROLES,
  Roles,
  type AuthenticatedUser,
} from "@food-delivery/service-kit";
import { assertManagesRestaurant } from "./restaurant-access";
import { GetRestaurantMenuUseCase } from "../../application/use-cases/get-restaurant-menu.use-case";
import { GetStopListHistoryUseCase } from "../../application/use-cases/get-stop-list-history.use-case";
import { ManageMenuItemUseCase } from "../../application/use-cases/manage-menu-item.use-case";
import {
  ManageMenuStructureUseCase,
  type GroupInput,
} from "../../application/use-cases/manage-menu-structure.use-case";
import { PriceMenuItemUseCase } from "../../application/use-cases/price-menu-item.use-case";
import { SearchMenuUseCase } from "../../application/use-cases/search-menu.use-case";
import { SetMenuItemAvailabilityUseCase } from "../../application/use-cases/set-menu-item-availability.use-case";
import type { MenuSection } from "../../domain/menu-category";
import type { MenuCategory } from "../../domain/menu-category";
import type { MenuItem, OptionSelection } from "../../domain/menu-item";
import type { StopListEntry } from "../../domain/stop-list";

/**
 * Слой интерфейса: принимает запрос, вызывает сценарий, превращает
 * доменные объекты в ответ. Бизнес-правил здесь нет.
 *
 * Доменные объекты наружу не отдаются: иначе внутреннее устройство
 * домена станет частью внешнего контракта и его нельзя будет менять.
 *
 * Проверка прав появится на шаге 1.4 вместе с ролями; пока
 * идентификатор ресторана приходит в пути запроса.
 */

const optionGroupToResponse = (item: MenuItem) =>
  item.optionGroups.map((group) => ({
    id: group.id,
    name: group.name,
    selectionType: group.selectionType,
    isRequired: group.isRequired,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    options: group.options.map((option) => ({
      id: option.id,
      name: option.name,
      priceDelta: option.priceDelta,
      isAvailable: option.isAvailable,
    })),
  }));

const itemToResponse = (item: MenuItem) => ({
  id: item.id,
  categoryId: item.categoryId,
  name: item.name,
  description: item.description,
  composition: item.composition,
  imageUrl: item.imageUrl,
  price: item.price,
  weightGrams: item.weightGrams,
  calories: item.calories,
  isAvailable: item.isAvailable,
  optionGroups: optionGroupToResponse(item),
});

const menuToResponse = (sections: MenuSection[]) =>
  sections.map((section) => ({
    id: section.category.id,
    name: section.category.name,
    items: section.items.map(itemToResponse),
  }));

const categoryToResponse = (category: MenuCategory) => ({
  id: category.id,
  restaurantId: category.restaurantId,
  name: category.name,
  sortOrder: category.sortOrder,
  isActive: category.isActive,
});

interface CreateItemBody {
  categoryId: string;
  name: string;
  price: number;
  description?: string | null;
  composition?: string | null;
  imageUrl?: string | null;
  weightGrams?: number | null;
  calories?: number | null;
  sortOrder?: number;
}

interface UpdateItemBody extends Partial<CreateItemBody> {
  restaurantId: string;
}

interface PriceBody {
  selections?: OptionSelection[];
  quantity?: number;
}

interface AvailabilityBody {
  restaurantId: string;
  isAvailable: boolean;
  reason?: string | null;
}

const stopListEntryToResponse = (entry: StopListEntry) => ({
  id: entry.id,
  menuItemId: entry.menuItemId,
  reason: entry.reason,
  stoppedAt: entry.stoppedAt.toISOString(),
  restoredAt: entry.restoredAt?.toISOString() ?? null,
  isActive: entry.isActive,
  outageMinutes: entry.outageMinutes(),
});

@Controller()
export class MenuController {
  constructor(
    private readonly getMenu: GetRestaurantMenuUseCase,
    private readonly manageItem: ManageMenuItemUseCase,
    private readonly manageStructure: ManageMenuStructureUseCase,
    private readonly priceItem: PriceMenuItemUseCase,
    private readonly searchMenu: SearchMenuUseCase,
    private readonly setAvailability: SetMenuItemAvailabilityUseCase,
    private readonly stopListHistory: GetStopListHistoryUseCase,
  ) {}

  @Public()
  @Get("menu/search")
  async search(
    @Query("q") q: string,
    @Query("restaurantId") restaurantId?: string,
    @Query("limit") limit?: string,
  ) {
    const items = await this.searchMenu.execute({
      query: q,
      restaurantId,
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
    return { items };
  }

  /**
   * CAT-2: меню ресторана, сгруппированное по категориям.
   *
   * Открыто без входа: выбирать еду клиент должен до того, как заводить
   * учётную запись. Блюда из стоп-листа при этом видит только сотрудник
   * ресторана — право на это берётся из токена, а не из запроса.
   */
  @Public()
  @Get("restaurants/:restaurantId/menu")
  async menu(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
    @Query("includeUnavailable") includeUnavailable?: string,
  ) {
    const wantsAll = includeUnavailable === "true";
    if (wantsAll) {
      assertManagesRestaurant(user, restaurantId);
    }

    const sections = await this.getMenu.execute({
      restaurantId,
      includeUnavailable: wantsAll,
    });

    return { restaurantId, categories: menuToResponse(sections) };
  }

  /** CAT-5: менеджер добавляет блюдо. */
  @Roles(ROLES.manager, ROLES.admin)
  @Post("restaurants/:restaurantId/menu/items")
  async createItem(
    @Param("restaurantId") restaurantId: string,
    @Body() body: CreateItemBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);

    const item = await this.manageItem.create({ ...body, restaurantId });
    return itemToResponse(item);
  }

  /** CAT-5: менеджер меняет блюдо. */
  @Roles(ROLES.manager, ROLES.admin)
  @Patch("menu/items/:itemId")
  async updateItem(
    @Param("itemId") itemId: string,
    @Body() body: UpdateItemBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, body.restaurantId);

    const item = await this.manageItem.update({ ...body, itemId });
    return itemToResponse(item);
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Delete("menu/items/:itemId")
  async removeItem(
    @Param("itemId") itemId: string,
    @Query("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);
    await this.manageItem.remove(itemId, restaurantId);
    return { id: itemId, deleted: true };
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Get("restaurants/:restaurantId/menu/categories")
  async categories(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);
    return {
      categories: (await this.manageStructure.listCategories(restaurantId)).map(categoryToResponse),
    };
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Post("restaurants/:restaurantId/menu/categories")
  async createCategory(
    @Param("restaurantId") restaurantId: string,
    @Body() body: { name: string; sortOrder?: number },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);
    return categoryToResponse(await this.manageStructure.createCategory({ ...body, restaurantId }));
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Patch("menu/categories/:categoryId")
  async updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() body: { restaurantId: string; name?: string; sortOrder?: number; isActive?: boolean },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, body.restaurantId);
    return categoryToResponse(await this.manageStructure.updateCategory(categoryId, body));
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Delete("menu/categories/:categoryId")
  async deactivateCategory(
    @Param("categoryId") categoryId: string,
    @Query("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);
    return categoryToResponse(
      await this.manageStructure.deactivateCategory(categoryId, restaurantId),
    );
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Put("menu/items/:itemId/modifiers")
  async replaceModifiers(
    @Param("itemId") itemId: string,
    @Body() body: { restaurantId: string; groups: GroupInput[] },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, body.restaurantId);
    return itemToResponse(
      await this.manageStructure.replaceGroups(itemId, body.restaurantId, body.groups),
    );
  }

  /**
   * CAT-3: стоимость позиции с выбранными модификаторами.
   *
   * Считает сервис, а не браузер: браузер можно изменить, и тогда
   * в заказ придёт любая сумма.
   */
  @Public()
  @Post("menu/items/:itemId/price")
  @HttpCode(HttpStatus.OK)
  async price(@Param("itemId") itemId: string, @Body() body: PriceBody) {
    const price = await this.priceItem.execute({
      itemId,
      selections: body.selections ?? [],
      quantity: body.quantity ?? 1,
    });

    return price;
  }

  /**
   * CAT-4: перевод блюда в стоп-лист и возврат в продажу.
   *
   * Отдельный метод, а не поле в общем изменении блюда: это действие
   * кухни, а не редактирование меню, оно происходит в другой обстановке
   * и порождает другое событие.
   */
  @Roles(ROLES.manager, ROLES.kitchen, ROLES.admin)
  @Patch("menu/items/:itemId/availability")
  async availability(
    @Param("itemId") itemId: string,
    @Body() body: AvailabilityBody,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    // Убирать блюдо в стоп-лист вправе и кухня: именно там узнают,
    // что закончились ингредиенты.
    assertManagesRestaurant(user, body.restaurantId);

    const result = await this.setAvailability.execute({
      itemId,
      restaurantId: body.restaurantId,
      isAvailable: body.isAvailable,
      reason: body.reason ?? null,
    });

    return {
      item: itemToResponse(result.item),
      entry: stopListEntryToResponse(result.entry),
      changed: result.changed,
    };
  }

  /** История стоп-листа ресторана: что и как часто заканчивается. */
  @Roles(ROLES.manager, ROLES.kitchen, ROLES.admin)
  @Get("restaurants/:restaurantId/stop-list")
  async stopList(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user?: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    assertManagesRestaurant(user, restaurantId);

    const entries = await this.stopListHistory.execute({
      restaurantId,
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });

    return { restaurantId, entries: entries.map(stopListEntryToResponse) };
  }
}
