import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import {
  MENU_SEARCH_REPOSITORY,
  type MenuSearchHit,
  type MenuSearchRepository,
} from "../ports/menu-search.repository";

@Injectable()
export class SearchMenuUseCase {
  constructor(@Inject(MENU_SEARCH_REPOSITORY) private readonly search: MenuSearchRepository) {}

  async execute(input: {
    query: string;
    restaurantId?: string;
    limit?: number;
  }): Promise<MenuSearchHit[]> {
    const query = input.query?.trim();
    if (!query || query.length < 2 || query.length > 100) {
      throw new ValidationError("поисковый запрос должен содержать от 2 до 100 символов");
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationError("limit должен быть целым числом от 1 до 50");
    }
    if (
      input.restaurantId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.restaurantId)
    ) {
      throw new ValidationError("restaurantId должен быть UUID");
    }
    return this.search.search(query, input.restaurantId, limit);
  }
}
