import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type {
  MenuSearchHit,
  MenuSearchRepository,
} from "../../application/ports/menu-search.repository";

interface SearchRow {
  id: string;
  restaurant_id: string;
  category_id: string;
  name: string;
  composition: string | null;
  price: number;
  image_url: string | null;
}

@Injectable()
export class TypeOrmMenuSearchRepository implements MenuSearchRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async search(
    query: string,
    restaurantId: string | undefined,
    limit: number,
  ): Promise<MenuSearchHit[]> {
    const rows = await this.dataSource.query<SearchRow[]>(
      `SELECT i.id, i.restaurant_id, i.category_id, i.name, i.composition, i.price, i.image_url
         FROM menu_items i
         JOIN restaurants r ON r.id = i.restaurant_id
         JOIN menu_categories c ON c.id = i.category_id
        WHERE r.is_active AND c.is_active AND i.is_available AND NOT i.is_deleted
          AND ($2::uuid IS NULL OR i.restaurant_id = $2::uuid)
          AND to_tsvector('russian', coalesce(i.name, '') || ' ' || coalesce(i.composition, ''))
              @@ websearch_to_tsquery('russian', $1)
        ORDER BY ts_rank(
          to_tsvector('russian', coalesce(i.name, '') || ' ' || coalesce(i.composition, '')),
          websearch_to_tsquery('russian', $1)) DESC, i.name ASC
        LIMIT $3`,
      [query, restaurantId ?? null, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      restaurantId: row.restaurant_id,
      categoryId: row.category_id,
      name: row.name,
      composition: row.composition,
      price: row.price,
      imageUrl: row.image_url,
    }));
  }
}
