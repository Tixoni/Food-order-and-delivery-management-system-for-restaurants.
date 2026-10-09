import { StopListEntry } from "../../domain/stop-list";
import type { StopListEntryOrmEntity } from "./stop-list.orm-entity";

/** Единственное место, где журнал стоп-листа в базе встречается с доменом. */
export class StopListMapper {
  static toDomain(row: StopListEntryOrmEntity): StopListEntry {
    return StopListEntry.create({
      id: row.id,
      menuItemId: row.menuItemId,
      reason: row.reason,
      stoppedBy: row.stoppedBy,
      stoppedAt: row.stoppedAt,
      restoredAt: row.restoredAt,
    });
  }

  static toPersistence(entry: StopListEntry): Partial<StopListEntryOrmEntity> {
    return {
      id: entry.id,
      menuItemId: entry.menuItemId,
      reason: entry.reason,
      stoppedBy: entry.stoppedBy,
      stoppedAt: entry.stoppedAt,
      restoredAt: entry.restoredAt,
    };
  }
}
