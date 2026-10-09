import { MenuCategory, type MenuSection } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { ItemOption, OptionGroup } from "../../domain/option-group";
import { MenuCacheCodec } from "./menu-cache.codec";

const group = () =>
  OptionGroup.create({
    id: "g-size",
    name: "Размер",
    selectionType: "single",
    isRequired: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      ItemOption.create({ id: "o-medium", name: "Средний", priceDelta: 0, isAvailable: true }),
      ItemOption.create({ id: "o-large", name: "Большой", priceDelta: 9000, isAvailable: true }),
    ],
  });

const menu = (): MenuSection[] => [
  {
    category: MenuCategory.create({
      id: "c-1",
      restaurantId: "r-1",
      name: "Пицца",
      sortOrder: 0,
      isActive: true,
    }),
    items: [
      MenuItem.create({
        id: "i-1",
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Маргарита",
        description: "Томаты и моцарелла",
        price: 39000,
        weightGrams: 450,
        isAvailable: true,
        sortOrder: 0,
        optionGroups: [group()],
      }),
    ],
  },
];

describe("формат хранения меню в кэше", () => {
  it("после записи и чтения меню остаётся тем же", () => {
    const decoded = MenuCacheCodec.decode(MenuCacheCodec.encode(menu()));

    expect(decoded).not.toBeNull();
    expect(decoded?.[0].category.name).toBe("Пицца");
    expect(decoded?.[0].items[0].name).toBe("Маргарита");
    expect(decoded?.[0].items[0].weightGrams).toBe(450);
  });

  it("прочитанное блюдо — полноценный доменный объект, а не разобранный JSON", () => {
    const decoded = MenuCacheCodec.decode(MenuCacheCodec.encode(menu()));
    const item = decoded?.[0].items[0] as MenuItem;

    // Расчёт цены доступен только настоящему доменному объекту
    const price = item.calculatePrice([{ groupId: "g-size", optionIds: ["o-large"] }], 2);
    expect(price.lineTotal).toBe(96000);
  });

  it("запись прошлой версии формата считается отсутствующей", () => {
    expect(MenuCacheCodec.decode('{"v":0,"sections":[]}')).toBeNull();
  });

  it("испорченная запись не приводит к ошибке", () => {
    expect(MenuCacheCodec.decode("{не json")).toBeNull();
    expect(MenuCacheCodec.decode("null")).toBeNull();
    expect(MenuCacheCodec.decode('{"v":1}')).toBeNull();
  });

  it("запись, нарушающая правило домена, отбрасывается, а не отдаётся клиенту", () => {
    const broken = JSON.parse(MenuCacheCodec.encode(menu()));
    broken.sections[0].items[0].price = -500;

    expect(MenuCacheCodec.decode(JSON.stringify(broken))).toBeNull();
  });

  it("пустое меню переживает запись и чтение", () => {
    expect(MenuCacheCodec.decode(MenuCacheCodec.encode([]))).toEqual([]);
  });
});
