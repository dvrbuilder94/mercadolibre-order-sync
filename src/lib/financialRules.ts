export type TaxDocumentType =
  | "boleta"
  | "factura"
  | "nota_credito"
  | "nota_debito"
  | "factura_exenta"
  | string
  | null
  | undefined;

/**
 * Bsale stores credit-note amounts as positive numbers. For period totals they
 * must reduce invoiced sales and tax, while debit notes increase them.
 */
export const signedTaxDocumentAmount = (
  documentType: TaxDocumentType,
  amount: number | string | null | undefined,
): number => {
  const parsed = Number(amount ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return documentType === "nota_credito" ? -Math.abs(parsed) : parsed;
};

export interface ReleasablePayment {
  has_exact_data?: boolean | null;
  money_release_date?: string | null;
}

/**
 * Exact payment data only means Mercado Pago confirmed the figures. Cash is
 * available when the confirmed release date has actually arrived.
 */
export const isPaymentReleased = (
  payment: ReleasablePayment | null | undefined,
  now: Date = new Date(),
): boolean => {
  if (payment?.has_exact_data !== true || !payment.money_release_date) return false;
  const releaseAt = new Date(payment.money_release_date);
  return Number.isFinite(releaseAt.getTime()) && releaseAt <= now;
};
