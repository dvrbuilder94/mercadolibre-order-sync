import { describe, expect, it } from "vitest";
import { calculateMonthlyControl } from "./monthlyControl";

describe("golden monthly flow", () => {
  it("reconciles sales, credit note, refund and cash without hidden differences", () => {
    const snapshot = calculateMonthlyControl({
      period: "2026-07",
      orders: [
        { gross: 119_000, status: "paid", exactPayment: true, hasValidDte: true },
        { gross: 59_500, status: "paid", exactPayment: true, hasValidDte: true },
      ],
      documents: [
        { total: 119_000, tax: 19_000, type: "factura", status: "issued", linked: true },
        { total: 59_500, tax: 9_500, type: "boleta", status: "issued", linked: true },
        { total: 59_500, tax: 9_500, type: "nota_credito", status: "issued", linked: true },
      ],
      payments: [
        { gross: 119_000, fees: 11_900, net: 105_000, status: "APPROVED", matched: true },
        { gross: 59_500, fees: 5_950, net: 52_500, status: "APPROVED", matched: true },
        { gross: -59_500, fees: 0, net: -59_500, status: "REFUND", matched: true },
        // Synthetic settlement summaries never enter the cash ledger.
        { gross: 999_999, fees: 0, net: 999_999, status: "BATCH", matched: false, logicalBatch: true },
      ],
    });

    expect(snapshot.commercial.gross_sales).toBe(178_500);
    expect(snapshot.fiscal.gross_documents).toBe(119_000);
    expect(snapshot.fiscal.tax_documents).toBe(19_000);
    expect(snapshot.cash.gross_movements).toBe(119_000);
    expect(snapshot.cash.net_movements).toBe(98_000);
    expect(snapshot.cash.fees).toBe(17_850);
    expect(snapshot.cash.other_deductions).toBe(3_150);
    expect(
      snapshot.cash.gross_movements - snapshot.cash.fees - snapshot.cash.other_deductions,
    ).toBe(snapshot.cash.net_movements);
    expect(snapshot.bridges).toEqual({
      commercial_after_reversals: 119_000,
      fiscal_vs_commercial_after_reversals: 0,
      cash_gross_vs_fiscal: 0,
    });
    expect(snapshot.cash.unmatched_movement_count).toBe(0);
  });
});
