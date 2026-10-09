export interface MenuSearchHit {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  composition: string | null;
  price: number;
  imageUrl: string | null;
}

export interface MenuSearchRepository {
  search(query: string, restaurantId: string | undefined, limit: number): Promise<MenuSearchHit[]>;
}

export const MENU_SEARCH_REPOSITORY = Symbol("MenuSearchRepository");
