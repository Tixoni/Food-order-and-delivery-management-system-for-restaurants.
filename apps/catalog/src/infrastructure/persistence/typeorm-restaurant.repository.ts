import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import type { Restaurant } from "../../domain/restaurant";
import type { RestaurantRepository } from "../../application/ports/restaurant.repository";
import { RestaurantOrmEntity } from "./restaurant.orm-entity";
import { RestaurantMapper } from "./restaurant.mapper";
import { writeOutbox } from "./outbox.writer";

/**
 * Реализация порта поверх PostgreSQL. Инфраструктурный слой —
 * единственное место, где сервис знает про SQL и TypeORM.
 */
@Injectable()
export class TypeOrmRestaurantRepository implements RestaurantRepository {
  constructor(
    @InjectRepository(RestaurantOrmEntity)
    private readonly repository: Repository<RestaurantOrmEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
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

  async save(restaurant: Restaurant, events: readonly DomainEvent[] = []): Promise<void> {
    // upsert, а не save: save сначала делает выборку, чтобы решить,
    // вставка это или обновление, — лишний запрос на каждое сохранение.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(RestaurantOrmEntity).upsert(
        {
          ...RestaurantMapper.toPersistence(restaurant),
          updatedAt: new Date(),
        } as RestaurantOrmEntity,
        ["id"],
      );
      await writeOutbox(manager, events);
    });
  }
}
