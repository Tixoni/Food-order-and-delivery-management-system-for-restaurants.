import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Журнал стоп-листа: история того, что и когда убирали из продажи. */
@Entity("stop_list_entries")
export class StopListEntryOrmEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Index("ix_stop_list_active")
  @Column("uuid", { name: "menu_item_id" })
  menuItemId!: string;

  @Column("varchar", { length: 500, nullable: true })
  reason!: string | null;

  @Column("uuid", { name: "stopped_by", nullable: true })
  stoppedBy!: string | null;

  @Column("timestamptz", { name: "stopped_at", default: () => "now()" })
  stoppedAt!: Date;

  /** Пока null — блюдо в стоп-листе. */
  @Column("timestamptz", { name: "restored_at", nullable: true })
  restoredAt!: Date | null;
}
