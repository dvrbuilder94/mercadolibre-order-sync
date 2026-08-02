import { describe, expect, it } from "vitest";
import { isPaymentReleased, signedTaxDocumentAmount } from "./financialRules";

describe("signedTaxDocumentAmount", () => {
  it("subtracts credit notes stored as positive amounts", () => {
    expect(signedTaxDocumentAmount("nota_credito", 11900)).toBe(-11900);
  });

  it("keeps invoices and debit notes positive", () => {
    expect(signedTaxDocumentAmount("factura", 11900)).toBe(11900);
    expect(signedTaxDocumentAmount("nota_debito", 2500)).toBe(2500);
  });
});

describe("isPaymentReleased", () => {
  const now = new Date("2026-08-02T12:00:00Z");

  it("requires exact data and a release date that already arrived", () => {
    expect(isPaymentReleased({ has_exact_data: true, money_release_date: "2026-08-01T12:00:00Z" }, now)).toBe(true);
    expect(isPaymentReleased({ has_exact_data: true, money_release_date: "2026-08-03T12:00:00Z" }, now)).toBe(false);
  });

  it("does not confuse exact data with released cash", () => {
    expect(isPaymentReleased({ has_exact_data: true, money_release_date: null }, now)).toBe(false);
    expect(isPaymentReleased({ has_exact_data: false, money_release_date: "2026-08-01T12:00:00Z" }, now)).toBe(false);
  });
});
