import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Точка в формате GeoJSON — именно так TypeORM отдаёт и принимает географические значения. */
export interface GeoPoint {
  type: "Point";
  coordinates: [number, number]; // [долгота, широта]
}

export interface GeoPolygon {
  type: "Polygon";
  coordinates: [number, number][][];
}

@Entity("restaurants")
export class Restaurant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("varchar")
  name!: string;

  @Index({ spatial: true })
  @Column({
    type: "geography",
    spatialFeatureType: "Point",
    srid: 4326,
    nullable: true,
  })
  location!: GeoPoint | null;
}

@Entity("delivery_zones")
export class DeliveryZone {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("uuid")
  restaurantId!: string;

  @Index({ spatial: true })
  @Column({
    type: "geography",
    spatialFeatureType: "Polygon",
    srid: 4326,
  })
  area!: GeoPolygon;

  @Column("numeric", { precision: 10, scale: 2, default: 150 })
  deliveryFee!: string;
}

@Entity("couriers")
export class Courier {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("varchar")
  name!: string;

  /** offline | available | busy */
  @Column("varchar", { default: "available" })
  status!: string;

  @Index({ spatial: true })
  @Column({
    type: "geography",
    spatialFeatureType: "Point",
    srid: 4326,
    nullable: true,
  })
  lastLocation!: GeoPoint | null;
}
