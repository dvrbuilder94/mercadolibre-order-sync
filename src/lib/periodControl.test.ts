import { describe, expect, it } from "vitest";
import { summarizePeriodControl } from "./periodControl";

describe("summarizePeriodControl", () => {
  it("uses one MELI sales cohort for documents and Mercado Pago", () => {
    const summary = summarizePeriodControl(
      [
        { id: "sale-1", gross_amount: 100_000, money_release_date: "2026-07-10T00:00:00Z" },
        { id: "sale-2", gross_amount: 50_000, money_release_date: "2026-08-10T00:00:00Z" },
        { id: "sale-3", gross_amount: 25_000, money_release_date: null },
      ],
      [
        { order_id: "sale-1", allocated_amount: 100_000, tax_documents: { status: "issued", document_type: "boleta" } },
        { order_id: "sale-2", allocated_amount: 50_000, tax_documents: { status: "issued", document_type: "factura" } },
        { order_id: "sale-3", allocated_amount: 25_000, tax_documents: { status: "voided", document_type: "boleta" } },
      ],
      [
        { sale_id: "sale-1", allocated_amount: 82_000, payments: { id: "pay-1", raw_data: { money_release_date: "2026-07-10T00:00:00Z" } } },
        { sale_id: "sale-2", allocated_amount: 41_000, payments: { id: "pay-2", raw_data: { money_release_date: "2026-08-10T00:00:00Z" } } },
        { sale_id: "sale-1", allocated_amount: -10_000, payments: { id: "refund-1", raw_data: { ledger_type: "MP_REFUND" } } },
      ],
      new Date("2026-07-31T00:00:00Z"),
    );

    expect(summary.salesGross).toBe(175_000);
    expect(summary.documentedCount).toBe(2);
    expect(summary.documentAllocated).toBe(150_000);
    expect(summary.documentDelta).toBe(0);
    expect(summary.withoutDocumentGross).toBe(25_000);
    expect(summary.paidSalesGross).toBe(150_000);
    expect(summary.approvedNet).toBe(123_000);
    expect(summary.deductionsAndAdjustments).toBe(27_000);
    expect(summary.refunds).toBe(10_000);
    expect(summary.netAfterAdjustments).toBe(113_000);
    expect(summary.releasedNet).toBe(72_000);
    expect(summary.pendingReleaseNet).toBe(41_000);
    expect(summary.withoutPaymentGross).toBe(25_000);
  });

  it("excludes credit notes and legacy synthetic batches from the control", () => {
    const summary = summarizePeriodControl(
      [{ id: "sale-1", gross_amount: 100_000, money_release_date: null }],
      [{ order_id: "sale-1", allocated_amount: 100_000, tax_documents: { status: "issued", document_type: "nota_credito" } }],
      [{ sale_id: "sale-1", allocated_amount: 90_000, payments: { id: "legacy", raw_data: { ledger_type: "LOGICAL_BATCH" } } }],
    );

    expect(summary.documentedCount).toBe(0);
    expect(summary.paidCount).toBe(0);
    expect(summary.approvedNet).toBe(0);
  });
});
