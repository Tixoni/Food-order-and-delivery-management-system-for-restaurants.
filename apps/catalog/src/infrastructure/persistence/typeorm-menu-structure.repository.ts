import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import type { DomainEvent } from "@food-delivery/shared";
import type { MenuCategory } from "../../domain/menu-category";
import type { OptionGroup } from "../../domain/option-group";
import type { MenuStructureRepository } from "../../application/ports/menu-structure.repository";
import { MenuMapper } from "./menu.mapper";
import {
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  MenuCategoryOrmEntity,
} from "./menu.orm-entities";
import { writeOutbox } from "./outbox.writer";

@Injectable()
export class TypeOrmMenuStructureRepository implements MenuStructureRepository {
  constructor(
    @InjectRepository(MenuCategoryOrmEntity)
    private readonly categories: Repository<MenuCategoryOrmEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findCategoryById(id: string): Promise<MenuCategory | null> {
    const row = await this.categories.findOne({ where: { id } });
    return row ? MenuMapper.categoryToDomain(row) : null;
  }

  async saveCategory(category: MenuCategory, events: DomainEvent[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(MenuCategoryOrmEntity)
        .upsert(MenuMapper.categoryToPersistence(category) as MenuCategoryOrmEntity, ["id"]);
      await writeOutbox(manager, events);
    });
  }

  async replaceGroups(
    itemId: string,
    groups: readonly OptionGroup[],
    events: DomainEvent[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const groupRepo = manager.getRepository(ItemOptionGroupOrmEntity);
      const optionRepo = manager.getRepository(ItemOptionOrmEntity);
      const old = await groupRepo.find({ where: { menuItemId: itemId } });
      if (old.length) {
        // Варианты удаляются внешним ключом ON DELETE CASCADE.
        await groupRepo.delete(old.map((group) => group.id));
      }
      for (const [groupIndex, group] of groups.entries()) {
        await groupRepo.insert({
          id: group.id,
          menuItemId: itemId,
          name: group.name,
          selectionType: group.selectionType,
          isRequired: group.isRequired,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          sortOrder: groupIndex,
        });
        if (group.options.length) {
          await optionRepo.insert(
            group.options.map((option, optionIndex) => ({
              id: option.id,
              groupId: group.id,
              name: option.name,
              priceDelta: option.priceDelta,
              isAvailable: option.isAvailable,
              sortOrder: optionIndex,
            })),
          );
        }
      }
      await writeOutbox(manager, events);
    });
  }
}
