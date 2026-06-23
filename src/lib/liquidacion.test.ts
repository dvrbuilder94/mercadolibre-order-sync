import { describe, it, expect } from "vitest";
import { isLiquidacionStuck, daysSince } from "./liquidacion";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("isLiquidacionStuck", () => {
  it("una orden con neto exacto nunca está colgada", () => {
    expect(isLiquidacionStuck({ has_exact_data: true, money_release_date: daysAgo(30) })).toBe(false);
  });

  it("estimado pero la fecha de liberación todavía no llega: no está colgada", () => {
    expect(isLiquidacionStuck({ has_exact_data: false, money_release_date: daysAhead(3) })).toBe(false);
  });

  it("estimado y la fecha de liberación ya pasó sin confirmar: colgada", () => {
    expect(isLiquidacionStuck({ has_exact_data: false, money_release_date: daysAgo(1) })).toBe(true);
  });

  it("sin fecha de liberación (pago nunca se aprobó), pero la orden es reciente: no está colgada", () => {
    expect(isLiquidacionStuck({ has_exact_data: false, money_release_date: null, order_date: daysAgo(2) })).toBe(false);
  });

  it("sin fecha de liberación y la orden ya es vieja: colgada", () => {
    expect(isLiquidacionStuck({ has_exact_data: false, money_release_date: null, order_date: daysAgo(10) })).toBe(true);
  });

  it("sin ningún dato de fecha: no inventa una alerta", () => {
    expect(isLiquidacionStuck({ has_exact_data: false })).toBe(false);
  });
});

describe("daysSince", () => {
  it("null/undefined da null", () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince(undefined)).toBeNull();
  });

  it("calcula días enteros transcurridos", () => {
    expect(daysSince(daysAgo(7))).toBe(7);
  });
});
