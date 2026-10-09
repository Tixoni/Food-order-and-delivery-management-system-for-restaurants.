import { StopListEntry, StopListError } from "./stop-list";

const AT = new Date("2026-09-22T10:00:00.000Z");

const open = (overrides: Partial<Parameters<typeof StopListEntry.open>[0]> = {}) =>
  StopListEntry.open({
    id: "11111111-1111-1111-1111-111111111111",
    menuItemId: "22222222-2222-2222-2222-222222222222",
    at: AT,
    ...overrides,
  });

describe("StopListEntry", () => {
  it("открытая запись считается действующей", () => {
    const entry = open();

    expect(entry.isActive).toBe(true);
    expect(entry.restoredAt).toBeNull();
  });

  it("обрезает причину и приводит пустую строку к отсутствию причины", () => {
    expect(open({ reason: "  закончился сыр  " }).reason).toBe("закончился сыр");
    expect(open({ reason: "   " }).reason).toBeNull();
  });

  it("отвергает слишком длинную причину", () => {
    expect(() => open({ reason: "я".repeat(501) })).toThrow(StopListError);
  });

  it("требует ссылку на блюдо", () => {
    expect(() => open({ menuItemId: "  " })).toThrow(StopListError);
  });

  it("закрытие записи возвращает блюдо в продажу", () => {
    const restored = open().restore(new Date("2026-09-22T12:30:00.000Z"));

    expect(restored.isActive).toBe(false);
    expect(restored.outageMinutes()).toBe(150);
  });

  it("повторное закрытие запрещено: иначе время простоя перезапишется", () => {
    const restored = open().restore(new Date("2026-09-22T12:00:00.000Z"));

    expect(() => restored.restore()).toThrow(StopListError);
  });

  it("не допускает возврат раньше, чем блюдо убрали", () => {
    expect(() => open().restore(new Date("2026-09-22T09:00:00.000Z"))).toThrow(StopListError);
  });

  it("для незакрытой записи простой считается по текущий момент", () => {
    const entry = open();

    expect(entry.outageMinutes(new Date("2026-09-22T11:00:00.000Z"))).toBe(60);
  });

  it("исходная запись не меняется при закрытии", () => {
    const entry = open();
    entry.restore();

    expect(entry.isActive).toBe(true);
  });
});
