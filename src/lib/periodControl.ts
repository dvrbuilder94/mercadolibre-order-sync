export const SALE_DOCUMENT_TYPES = new Set(["boleta", "factura", "factura_exenta"]);

export interface PeriodControlOrder {
  id: string;
  gross_amount: number | null;
  money_release_date: string | null;
}

export interface PeriodControlDocLink {
  order_id: string;
  allocated_amount: number | null;
  tax_documents:
    | { status: string | null; document_type: string | null }
    | { status: string | null; document_type: string | null }[]
    | null;
}

export interface PeriodControlPaymentLink {
  sale_id: string;
  allocated_amount: number | null;
  payments:
    | { id: string; raw_data: Record<string, unknown> | null }
    | { id: string; raw_data: Record<string, unknown> | null }[]
    | null;
}

export interface PeriodControlSummary {
  salesCount: number;
  salesGross: number;
  documentedCount: number;
  documentedSalesGross: number;
  documentAllocated: number;
  documentDelta: number;
  withoutDocumentCount: number;
  withoutDocumentGross: number;
  paidCount: number;
  paidSalesGross: number;
  approvedNet: number;
  deductionsAndAdjustments: number;
  refunds: number;
  netAfterAdjustments: number;
  releasedNet: number;
  pendingReleaseNet: number;
  withoutPaymentCount: number;
  withoutPaymentGross: number;
}

const relationOne = <T>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? value[0] ?? null : value;

const isSaleDocument = (link: PeriodControlDocLink) => {
  const document = relationOne(link.tax_documents);
  return !!document
    && document.status !== "voided"
    && SALE_DOCUMENT_TYPES.has(document.document_type || "");
};

const releaseDateFromRaw = (raw: Record<string, unknown> | null): string | null => {
  if (!raw) return null;
  const direct = raw.money_release_date;
  if (typeof direct === "string") return direct;
  const mpPayment = raw.mp_payment;
  if (mpPayment && typeof mpPayment === "object") {
    const nested = (mpPayment as Record<string, unknown>).money_release_date;
    if (typeof nested === "string") return nested;
  }
  return null;
};

export function summarizePeriodControl(
  orders: PeriodControlOrder[],
  docLinks: PeriodControlDocLink[],
  paymentLinks: PeriodControlPaymentLink[],
  now = new Date(),
): PeriodControlSummary {
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const gross = (id: string) => Number(orderById.get(id)?.gross_amount || 0);

  const validDocLinks = docLinks.filter(isSaleDocument);
  const documentedIds = new Set(validDocLinks.map((link) => link.order_id));
  const documentedSalesGross = [...documentedIds].reduce((sum, id) => sum + gross(id), 0);
  const documentAllocated = validDocLinks.reduce(
    (sum, link) => sum + Number(link.allocated_amount || 0),
    0,
  );

  const realPaymentLinks = paymentLinks.filter((link) => {
    const payment = relationOne(link.payments);
    return payment?.raw_data?.ledger_type !== "LOGICAL_BATCH";
  });
  const positiveLinks = realPaymentLinks.filter((link) => Number(link.allocated_amount || 0) > 0);
  const paidIds = new Set(positiveLinks.map((link) => link.sale_id));
  const approvedNet = positiveLinks.reduce(
    (sum, link) => sum + Number(link.allocated_amount || 0),
    0,
  );
  const refunds = Math.abs(realPaymentLinks
    .filter((link) => Number(link.allocated_amount || 0) < 0)
    .reduce((sum, link) => sum + Number(link.allocated_amount || 0), 0));

  const releasedNet = realPaymentLinks.reduce((sum, link) => {
    const amount = Number(link.allocated_amount || 0);
    if (amount < 0) return sum + amount;
    const payment = relationOne(link.payments);
    const releaseDate = releaseDateFromRaw(payment?.raw_data || null)
      || orderById.get(link.sale_id)?.money_release_date
      || null;
    return releaseDate && new Date(releaseDate) <= now ? sum + amount : sum;
  }, 0);

  const salesGross = orders.reduce((sum, order) => sum + Number(order.gross_amount || 0), 0);
  const paidSalesGross = [...paidIds].reduce((sum, id) => sum + gross(id), 0);
  const withoutDocument = orders.filter((order) => !documentedIds.has(order.id));
  const withoutPayment = orders.filter((order) => !paidIds.has(order.id));
  const netAfterAdjustments = approvedNet - refunds;

  return {
    salesCount: orders.length,
    salesGross,
    documentedCount: documentedIds.size,
    documentedSalesGross,
    documentAllocated,
    documentDelta: documentAllocated - documentedSalesGross,
    withoutDocumentCount: withoutDocument.length,
    withoutDocumentGross: withoutDocument.reduce((sum, order) => sum + Number(order.gross_amount || 0), 0),
    paidCount: paidIds.size,
    paidSalesGross,
    approvedNet,
    deductionsAndAdjustments: paidSalesGross - approvedNet,
    refunds,
    netAfterAdjustments,
    releasedNet,
    pendingReleaseNet: netAfterAdjustments - releasedNet,
    withoutPaymentCount: withoutPayment.length,
    withoutPaymentGross: withoutPayment.reduce((sum, order) => sum + Number(order.gross_amount || 0), 0),
  };
}
