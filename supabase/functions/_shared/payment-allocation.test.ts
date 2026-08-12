import { describe, expect, it } from "vitest";
import {
  AllocationOrder,
  AllocationPayment,
  resolvePaymentAllocations,
  validateAllocationInvariants,
  validateGrossOwnership,
} from "./payment-allocation.ts";

const order = (id: string, gross: number, explicitPaymentIds: string[] = []): AllocationOrder => ({
  id,
  gross,
  explicitPaymentIds,
});

const payment = (id: string, gross: number, net = gross): AllocationPayment => ({
  id,
  gross,
  net,
});

const orderIdsFor = (result: ReturnType<typeof resolvePaymentAllocations>, paymentId: string) =>
  result.allocations.filter((a) => a.paymentId === paymentId).map((a) => a.orderId).sort();

describe("resolvePaymentAllocations", () => {
  it("CASO A — pagos separados con ownership explícito de cada orden", () => {
    const orders = [order("A", 9990, ["p1"]), order("B", 34990, ["p2"])];
    const result = resolvePaymentAllocations([payment("p1", 9990), payment("p2", 34990)], orders);

    expect(result.unresolved).toEqual([]);
    expect(orderIdsFor(result, "p1")).toEqual(["A"]);
    expect(orderIdsFor(result, "p2")).toEqual(["B"]);
  });

  it("CASO B — mismo monto sin ownership: el pago queda sin asignar", () => {
    const orders = [order("A", 29990), order("B", 29990), order("C", 29990)];
    const result = resolvePaymentAllocations([payment("p1", 29990)], orders);

    expect(result.allocations).toEqual([]);
    expect(result.unresolved).toEqual([{ paymentId: "p1", reason: "ambiguous_amount" }]);
  });

  it("CASO C — ownership explícito manda sobre hermanas del mismo monto", () => {
    const orders = [order("A", 29990, ["p1"]), order("B", 29990), order("C", 29990)];
    const result = resolvePaymentAllocations([payment("p1", 29990)], orders);

    expect(orderIdsFor(result, "p1")).toEqual(["A"]);
    expect(result.allocations).toHaveLength(1);
  });

  it("CASO D — pago global único se prorratea por bruto", () => {
    const orders = [order("A", 10000), order("B", 30000)];
    const result = resolvePaymentAllocations([{ id: "p1", gross: 40000, net: 36000 }], orders);

    expect(orderIdsFor(result, "p1")).toEqual(["A", "B"]);
    const byOrder = Object.fromEntries(result.allocations.map((a) => [a.orderId, a.allocatedNet]));
    expect(byOrder.A).toBe(9000);
    expect(byOrder.B).toBe(27000);
    expect(result.allocations.every((a) => a.rule === "single_global_payment")).toBe(true);
  });

  it("CASO E — caso real 172760417808: nunca se reparte entre las 3 órdenes del pack", () => {
    const packOrders = [
      order("2000017828321480", 29990),
      order("2000017828324992", 29990),
      order("2000017828321482", 29990),
    ];
    const mp = { id: "172760417808", gross: 29990, net: 26091, fees: 3899 };

    // Sin ownership explícito: ambiguo → sin asignar.
    const ambiguous = resolvePaymentAllocations([mp], packOrders);
    expect(ambiguous.allocations).toEqual([]);
    expect(ambiguous.unresolved[0].reason).toBe("ambiguous_amount");

    // Con ownership explícito en una sola orden: exclusivo de esa orden.
    const owned = resolvePaymentAllocations([mp], [
      packOrders[0],
      packOrders[1],
      order("2000017828321482", 29990, ["172760417808"]),
    ]);
    expect(orderIdsFor(owned, "172760417808")).toEqual(["2000017828321482"]);
    expect(owned.allocations[0].allocatedNet).toBe(26091);
    expect(owned.allocations[0].allocatedFees).toBe(3899);
  });

  it("un pago que cubre el pack completo sí se prorratea aunque cuelgue de una orden", () => {
    const orders = [
      order("A", 29990, ["p1"]),
      order("B", 29990),
      order("C", 29990),
    ];
    const result = resolvePaymentAllocations([{ id: "p1", gross: 89970, net: 78000 }], orders);

    expect(orderIdsFor(result, "p1")).toEqual(["A", "B", "C"]);
    const total = result.allocations.reduce((s, a) => s + a.allocatedNet, 0);
    expect(total).toBe(78000);
  });

  it("no reparte por pack cuando el pago no cubre la suma del grupo", () => {
    const orders = [order("A", 29990), order("B", 15000), order("C", 29990)];
    const result = resolvePaymentAllocations([payment("p1", 12345)], orders);

    expect(result.allocations).toEqual([]);
    expect(result.unresolved[0].reason).toBe("no_candidate_order");
  });

  it("no fabrica un segundo reparto cuando quedan dos pagos sin resolver", () => {
    const orders = [order("A", 10000), order("B", 30000)];
    const result = resolvePaymentAllocations([payment("p1", 40000), payment("p2", 40000)], orders);

    expect(result.allocations).toEqual([]);
    expect(result.unresolved).toHaveLength(2);
  });
});

describe("invariantes", () => {
  it("acepta un reparto global coherente", () => {
    const orders = [order("A", 10000), order("B", 30000)];
    const p = { id: "p1", gross: 40000, net: 36000 };
    const { allocations } = resolvePaymentAllocations([p], orders);

    expect(validateAllocationInvariants(p, allocations)).toEqual({ ok: true });
    expect(validateGrossOwnership(p, allocations, orders)).toEqual({ ok: true });
  });

  it("rechaza el patrón histórico: un pago de 29.990 sobre órdenes que suman 89.970", () => {
    const orders = [order("A", 29990), order("B", 29990), order("C", 29990)];
    const p = { id: "172760417808", gross: 29990, net: 26091 };
    const bogus = orders.map((o) => ({
      paymentId: p.id,
      orderId: o.id,
      allocatedGross: 9996.67,
      allocatedNet: 8697,
      allocatedFees: 1299.67,
      rule: "single_global_payment" as const,
    }));

    const check = validateGrossOwnership(p, bogus, orders);
    expect(check.ok).toBe(false);
  });
});