import { describe, expect, it } from "vitest";
import { chileMonthDateRange, chileMonthIsoRange, chilePeriodNow } from "./chileDate";

const chileParts = (iso: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
);

describe("Chile month boundaries", () => {
  it.each(["2026-01", "2026-04", "2026-09", "2026-12"])(
    "covers exactly the Chile wall-clock month %s across DST",
    (period) => {
      const { from, toExclusive } = chileMonthIsoRange(period);
      const [year, month] = period.split("-").map(Number);
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;

      expect(chileParts(from)).toMatchObject({
        year: String(year), month: String(month).padStart(2, "0"), day: "01",
        hour: "00", minute: "00", second: "00",
      });
      expect(chileParts(toExclusive)).toMatchObject({
        year: String(nextYear), month: String(nextMonth).padStart(2, "0"), day: "01",
        hour: "00", minute: "00", second: "00",
      });
    },
  );

  it("keeps date-only boundaries separate from timestamp boundaries", () => {
    expect(chileMonthDateRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("rejects ambiguous periods", () => {
    expect(() => chileMonthIsoRange("2026-2")).toThrow("Período inválido");
    expect(() => chileMonthIsoRange("2026-13")).toThrow("Período inválido");
  });

  it("selects the current period in Chile, not in the browser timezone", () => {
    expect(chilePeriodNow(new Date("2026-08-01T02:00:00.000Z"))).toBe("2026-07");
  });
});
