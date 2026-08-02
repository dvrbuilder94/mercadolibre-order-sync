import { describe, expect, it } from "vitest";
import { TesoreriaPaymentRaw, toTesoreriaPayment } from "./tesoreria";

const payment = (overrides: Partial<TesoreriaPaymentRaw> = {}): TesoreriaPaymentRaw => ({
  id: "payment-1",
  external_payment_id: "mp-1",
  payment_provider: "MERCADOPAGO",
  payment_date: "2026-08-01T12:00:00Z",
  net_amount: 1000,
  fees_amount: 100,
  gross_amount: 1100,
  amount: 1000,
  status: "UNMATCHED",
  raw_data: null,
  payment_sales: [],
  ...overrides,
});

describe("toTesoreriaPayment release state", () => {
  it("keeps an unmatched payment pending when its release date is unknown", () => {
    expect(toTesoreriaPayment(payment()).liberado).toBe(false);
  });

  it("uses the Mercado Pago release date stored in raw_data", () => {
    expect(toTesoreriaPayment(payment({
      raw_data: { money_release_date: "2999-08-10T12:00:00Z" },
    })).liberado).toBe(false);
    expect(toTesoreriaPayment(payment({
      raw_data: { money_release_date: "2020-08-01T12:00:00Z" },
    })).liberado).toBe(true);
  });

  it("treats recorded refunds and chargebacks as effective movements", () => {
    expect(toTesoreriaPayment(payment({ status: "REFUND", net_amount: -1000 })).liberado).toBe(true);
    expect(toTesoreriaPayment(payment({ status: "CHARGEBACK", net_amount: -1000 })).liberado).toBe(true);
  });
});
