import { describe, it, expect } from "vitest";
// El mapper vive en _shared (lo usan las edge functions en Deno), pero es una
// función pura sin APIs de Deno, así que se puede testear acá directo.
import { mapMeliOrderStatus } from "../../supabase/functions/_shared/order-status.ts";

describe("mapMeliOrderStatus", () => {
  it("paid -> confirmed", () => {
    expect(mapMeliOrderStatus({ status: "paid" })).toBe("confirmed");
  });

  it("el envío manda cuando la venta está viva", () => {
    expect(mapMeliOrderStatus({ status: "paid", shipping: { status: "shipped" } })).toBe("shipped");
    expect(mapMeliOrderStatus({ status: "paid", shipping: { status: "delivered" } })).toBe("delivered");
  });

  it("estados desconocidos/pendientes caen en pending", () => {
    expect(mapMeliOrderStatus({ status: "payment_required" })).toBe("pending");
    expect(mapMeliOrderStatus({ status: "payment_in_process" })).toBe("pending");
    expect(mapMeliOrderStatus({})).toBe("pending");
  });

  it("preserva los estados descartados en vez de colapsarlos a pending", () => {
    expect(mapMeliOrderStatus({ status: "cancelled" })).toBe("cancelled");
    expect(mapMeliOrderStatus({ status: "invalid" })).toBe("invalid");
    expect(mapMeliOrderStatus({ status: "rejected" })).toBe("rejected");
  });

  it("un estado descartado NO queda tapado por el envío (era un bug latente)", () => {
    expect(mapMeliOrderStatus({ status: "cancelled", shipping: { status: "delivered" } })).toBe("cancelled");
  });
});
