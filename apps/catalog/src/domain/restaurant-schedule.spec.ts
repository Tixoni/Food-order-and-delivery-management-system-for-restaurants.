import { isOpenAt, validateSchedule } from "./restaurant-schedule";

describe("расписание ресторана", () => {
  it("отклоняет повторный день и нулевую смену", () => {
    expect(() =>
      validateSchedule([
        { dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" },
        { dayOfWeek: 1, opensAt: "10:00", closesAt: "20:00" },
      ]),
    ).toThrow(/повторяется/);
    expect(() => validateSchedule([{ dayOfWeek: 1, opensAt: "09:00", closesAt: "09:00" }])).toThrow(
      /различаться/,
    );
  });

  it("считает время в часовом поясе ресторана и конец исключает", () => {
    const hours = [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }];
    expect(isOpenAt(hours, "Europe/Moscow", new Date("2026-09-21T06:00:00Z"))).toBe(true);
    expect(isOpenAt(hours, "Europe/Moscow", new Date("2026-09-21T15:00:00Z"))).toBe(false);
    expect(isOpenAt([], "Europe/Moscow", new Date())).toBe(false);
  });

  it("ночная смена действует до утра следующего дня", () => {
    const hours = [{ dayOfWeek: 1, opensAt: "22:00", closesAt: "02:00" }];
    expect(isOpenAt(hours, "Europe/Moscow", new Date("2026-09-21T20:00:00Z"))).toBe(true);
    expect(isOpenAt(hours, "Europe/Moscow", new Date("2026-09-21T22:00:00Z"))).toBe(true);
    expect(isOpenAt(hours, "Europe/Moscow", new Date("2026-09-21T23:00:00Z"))).toBe(false);
  });
});
