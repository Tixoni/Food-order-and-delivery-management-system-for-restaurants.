import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { GetRestaurantMenuUseCase } from "../../application/use-cases/get-restaurant-menu.use-case";
import { ManageMenuItemUseCase } from "../../application/use-cases/manage-menu-item.use-case";
import { PriceMenuItemUseCase } from "../../application/use-cases/price-menu-item.use-case";
import type { MenuSection } from "../../domain/menu-category";
import type { MenuItem, OptionSelection } from "../../domain/menu-item";

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

interface CreateItemBody {
  categoryId: string;
  name: string;
  price: number;
  description?: string | null;
  composition?: string | null;
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

@Controller()
export class MenuController {
  constructor(
    private readonly getMenu: GetRestaurantMenuUseCase,
    private readonly manageItem: ManageMenuItemUseCase,
    private readonly priceItem: PriceMenuItemUseCase,
  ) {}

  /** CAT-2: меню ресторана, сгруппированное по категориям. */
  @Get("restaurants/:restaurantId/menu")
  async menu(
    @Param("restaurantId") restaurantId: string,
    @Query("includeUnavailable") includeUnavailable?: string,
  ) {
    const sections = await this.getMenu.execute({
      restaurantId,
      includeUnavailable: includeUnavailable === "true",
    });

    return { restaurantId, categories: menuToResponse(sections) };
  }

  /** CAT-5: менеджер добавляет блюдо. */
  @Post("restaurants/:restaurantId/menu/items")
  async createItem(@Param("restaurantId") restaurantId: string, @Body() body: CreateItemBody) {
    const item = await this.manageItem.create({ ...body, restaurantId });
    return itemToResponse(item);
  }

  /** CAT-5: менеджер меняет блюдо. */
  @Patch("menu/items/:itemId")
  async updateItem(@Param("itemId") itemId: string, @Body() body: UpdateItemBody) {
    const item = await this.manageItem.update({ ...body, itemId });
    return itemToResponse(item);
  }

  /**
   * CAT-3: стоимость позиции с выбранными модификаторами.
   *
   * Считает сервис, а не браузер: браузер можно изменить, и тогда
   * в заказ придёт любая сумма.
   */
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
}
