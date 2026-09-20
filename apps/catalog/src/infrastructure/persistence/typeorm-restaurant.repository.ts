import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { Restaurant } from "../../domain/restaurant";
import type { RestaurantRepository } from "../../application/ports/restaurant.repository";
import { RestaurantOrmEntity } from "./restaurant.orm-entity";
import { RestaurantMapper } from "./restaurant.mapper";

/**
 * Реализация порта поверх PostgreSQL. Инфраструктурный слой —
 * единственное место, где сервис знает про SQL и TypeORM.
 */
@Injectable()
export class TypeOrmRestaurantRepository implements RestaurantRepository {
  constructor(
    @InjectRepository(RestaurantOrmEntity)
    private readonly repository: Repository<RestaurantOrmEntity>,
  ) {}

  async findActive(limit: number, offset: number): Promise<Restaurant[]> {
    const rows = await this.repository.find({
      where: { isActive: true },
      order: { name: "ASC" },
      take: limit,
      skip: offset,
    });
    return rows.map(RestaurantMapper.toDomain);
  }

  async findById(id: string): Promise<Restaurant | null> {
    const row = await this.repository.findOne({ where: { id } });
    return row ? RestaurantMapper.toDomain(row) : null;
  }

  async countActive(): Promise<number> {
    return this.repository.count({ where: { isActive: true } });
  }
}
