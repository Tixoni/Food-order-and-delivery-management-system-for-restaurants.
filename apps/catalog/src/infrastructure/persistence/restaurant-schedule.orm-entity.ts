import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("restaurant_schedules")
@Index("UQ_restaurant_schedule_day", ["restaurantId", "dayOfWeek"], { unique: true })
export class RestaurantScheduleOrmEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("uuid", { name: "restaurant_id" })
  restaurantId!: string;

  @Column("smallint", { name: "day_of_week" })
  dayOfWeek!: number;

  @Column("time", { name: "opens_at" })
  opensAt!: string;

  @Column("time", { name: "closes_at" })
  closesAt!: string;
}
