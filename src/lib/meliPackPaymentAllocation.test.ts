import { describe, expect, it } from "vitest";
import { allocatePackPayments } from "../../supabase/functions/_shared/meli-pack-payment-allocation";

describe("allocatePackPayments", () => {
  it("keeps separate payments on the orders that explicitly contain their payment_id", () => {
    const result = allocatePackPayments(
      [
        { id: "mug", orderId: "MELI-MUG", gross: 9_990, paymentIds: ["171960274409"] },
        { id: "pants", orderId: "MELI-PANTS", gross: 34_990, paymentIds: ["171960366241"] },
      ],
      [
        { id: "171960274409", gross: 9_990, net: 9_100, fees: 890 },
        { id: "171960366241", gross: 34_990, net: 31_500, fees: 3_490 },
      ],
    );

    expect(result.unresolvedPaymentIds).toEqual([]);
    expect(result.allocations).toEqual([
      { paymentId: "171960274409", orderId: "mug", grossAllocated: 9_990, netAllocated: 9_100, feesAllocated: 890, reason: "payment_id" },
      { paymentId: "171960366241", orderId: "pants", grossAllocated: 34_990, netAllocated: 31_500, feesAllocated: 3_490, reason: "payment_id" },
    ]);
  });

  it("uses a unique exact amount match when payment_id ownership is unavailable", () => {
    const result = allocatePackPayments(
      [
        { id: "a", orderId: "A", gross: 9_990, paymentIds: [] },
        { id: "b", orderId: "B", gross: 34_990, paymentIds: [] },
      ],
      [
        { id: "p1", gross: 9_990, net: 9_000, fees: 990 },
        { id: "p2", gross: 34_990, net: 31_000, fees: 3_990 },
      ],
    );

    expect(result.allocations.map(({ paymentId, orderId, reason }) => ({ paymentId, orderId, reason }))).toEqual([
      { paymentId: "p1", orderId: "a", reason: "exact_amount" },
      { paymentId: "p2", orderId: "b", reason: "exact_amount" },
    ]);
    expect(result.unresolvedPaymentIds).toEqual([]);
  });

  it("prorates only when one unresolved payment exactly covers the remaining pack gross", () => {
    const result = allocatePackPayments(
      [
        { id: "a", orderId: "A", gross: 10_000, paymentIds: [] },
        { id: "b", orderId: "B", gross: 30_000, paymentIds: [] },
      ],
      [{ id: "global", gross: 40_000, net: 36_000, fees: 4_000 }],
    );

    expect(result.unresolvedPaymentIds).toEqual([]);
    expect(result.allocations).toEqual([
      { paymentId: "global", orderId: "a", grossAllocated: 10_000, netAllocated: 9_000, feesAllocated: 1_000, reason: "single_global_payment" },
      { paymentId: "global", orderId: "b", grossAllocated: 30_000, netAllocated: 27_000, feesAllocated: 3_000, reason: "single_global_payment" },
    ]);
  });

  it("does not fabricate an allocation when the evidence is ambiguous", () => {
    const result = allocatePackPayments(
      [
        { id: "a", orderId: "A", gross: 10_000, paymentIds: [] },
        { id: "b", orderId: "B", gross: 10_000, paymentIds: [] },
      ],
      [{ id: "ambiguous", gross: 10_000, net: 9_000, fees: 1_000 }],
    );

    expect(result.allocations).toEqual([]);
    expect(result.unresolvedPaymentIds).toEqual(["ambiguous"]);
  });

  it("preserves cents exactly when splitting a single global payment", () => {
    const result = allocatePackPayments(
      [
        { id: "a", orderId: "A", gross: 1, paymentIds: [] },
        { id: "b", orderId: "B", gross: 2, paymentIds: [] },
      ],
      [{ id: "global", gross: 3, net: 1, fees: 2 }],
    );

    expect(result.allocations.reduce((sum, row) => sum + row.netAllocated, 0)).toBe(1);
    expect(result.allocations.reduce((sum, row) => sum + row.feesAllocated, 0)).toBe(2);
  });
});
