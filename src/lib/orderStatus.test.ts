import { describe, it, expect } from "vitest";
import { isRealSale, NON_SALE_STATUSES, NON_SALE_STATUSES_PG } from "./orderStatus";

describe("isRealSale", () => {
  it("cuenta como venta los estados vivos", () => {
    for (const s of ["pending", "confirmed", "shipped", "delivered", "paid"]) {
      expect(isRealSale(s)).toBe(true);
    }
  });

  it("NO cuenta como venta los estados descartados", () => {
    for (const s of ["cancelled", "rejected", "invalid"]) {
      expect(isRealSale(s)).toBe(false);
    }
  });

  it("trata null/undefined como no-venta (no inventa una venta sin estado)", () => {
    expect(isRealSale(null)).toBe(false);
    expect(isRealSale(undefined)).toBe(false);
  });
});

describe("NON_SALE_STATUSES_PG", () => {
  it("arma la lista para el filtro .not('status','in', ...) de PostgREST", () => {
    expect(NON_SALE_STATUSES_PG).toBe(`(${NON_SALE_STATUSES.join(",")})`);
    expect(NON_SALE_STATUSES_PG).toBe("(cancelled,rejected,invalid)");
  });
});
