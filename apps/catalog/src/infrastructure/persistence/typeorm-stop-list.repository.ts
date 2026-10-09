import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, IsNull } from "typeorm";
import type { StopListEntry } from "../../domain/stop-list";
import type {
  AvailabilityChange,
  StopListRepository,
} from "../../application/ports/stop-list.repository";
import { MenuItemOrmEntity } from "./menu.orm-entities";
import { StopListEntryOrmEntity } from "./stop-list.orm-entity";
import { StopListMapper } from "./stop-list.mapper";
import { writeOutbox } from "./outbox.writer";

/**
 * Хранилище стоп-листа поверх PostgreSQL.
 *
 * Здесь выполняется главное обещание порта: признак доступности блюда,
 * запись журнала и событие для брокера сохраняются одной транзакцией.
 */
@Injectable()
export class TypeOrmStopListRepository implements StopListRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findActiveEntry(menuItemId: string): Promise<StopListEntry | null> {
    const row = await this.dataSource.getRepository(StopListEntryOrmEntity).findOne({
      where: { menuItemId, restoredAt: IsNull() },
      order: { stoppedAt: "DESC" },
    });

    return row ? StopListMapper.toDomain(row) : null;
  }

  async commit(change: AvailabilityChange): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(MenuItemOrmEntity)
        .update(
          { id: change.item.id },
          { isAvailable: change.item.isAvailable, updatedAt: new Date() },
        );

      await manager
        .getRepository(StopListEntryOrmEntity)
        .upsert(StopListMapper.toPersistence(change.entry) as StopListEntryOrmEntity, ["id"]);

      await writeOutbox(manager, change.events);
    });
  }

  async findHistory(restaurantId: string, limit: number): Promise<StopListEntry[]> {
    // Соединение с блюдами нужно только для отбора по ресторану: в самом
    // журнале ресторана нет, иначе его пришлось бы поддерживать в двух местах.
    const rows = await this.dataSource
      .getRepository(StopListEntryOrmEntity)
      .createQueryBuilder("entry")
      .innerJoin(MenuItemOrmEntity, "item", "item.id = entry.menu_item_id")
      .where("item.restaurant_id = :restaurantId", { restaurantId })
      .orderBy("entry.stopped_at", "DESC")
      .limit(limit)
      .getMany();

    return rows.map(StopListMapper.toDomain);
  }
}
