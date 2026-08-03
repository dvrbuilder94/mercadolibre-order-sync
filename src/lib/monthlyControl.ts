export interface MonthlyControlSnapshot {
  period: string;
  timezone: "America/Santiago";
  commercial: {
    order_count: number;
    gross_sales: number;
    exact_payment_order_count: number;
    awaiting_payment_order_count: number;
    with_valid_dte_order_count: number;
    without_valid_dte_order_count: number;
  };
  fiscal: {
    document_count: number;
    gross_documents: number;
    tax_documents: number;
    credit_notes: number;
    linked_document_count: number;
    unlinked_document_count: number;
  };
  cash: {
    movement_count: number;
    gross_movements: number;
    fees: number;
    other_deductions: number;
    net_movements: number;
    reversals: number;
    unmatched_movement_count: number;
  };
  bridges: {
    commercial_after_reversals: number;
    fiscal_vs_commercial_after_reversals: number;
    cash_gross_vs_fiscal: number;
  };
}

interface GoldenInput {
  period: string;
  orders: Array<{ gross: number; status: string; exactPayment: boolean; hasValidDte: boolean }>;
  documents: Array<{ total: number; tax: number; type: string; status: string; linked: boolean }>;
  payments: Array<{
    gross: number; fees: number; net: number; status: string; matched: boolean; logicalBatch?: boolean;
  }>;
}

/** Pure mirror of the RPC rules, used by the full-flow golden fixture. */
export const calculateMonthlyControl = (input: GoldenInput): MonthlyControlSnapshot => {
  const orders = input.orders.filter((order) => !["cancelled", "rejected", "invalid"].includes(order.status));
  const documents = input.documents.filter((document) => document.status === "issued");
  const payments = input.payments.filter((payment) => !payment.logicalBatch);
  const signed = (document: GoldenInput["documents"][number]) =>
    document.type === "nota_credito" ? -Math.abs(document.total) : document.total;
  const signedTax = (document: GoldenInput["documents"][number]) =>
    document.type === "nota_credito" ? -Math.abs(document.tax) : document.tax;
  const creditNotes = documents
    .filter((document) => document.type === "nota_credito")
    .reduce((sum, document) => sum + Math.abs(document.total), 0);
  const grossSales = orders.reduce((sum, order) => sum + order.gross, 0);
  const grossDocuments = documents.reduce((sum, document) => sum + signed(document), 0);
  const grossMovements = payments.reduce((sum, payment) => sum + payment.gross, 0);
  const linkedDocumentCount = documents.filter((document) => document.linked).length;
  const withValidDte = orders.filter((order) => order.hasValidDte).length;

  return {
    period: input.period,
    timezone: "America/Santiago",
    commercial: {
      order_count: orders.length,
      gross_sales: grossSales,
      exact_payment_order_count: orders.filter((order) => order.exactPayment).length,
      awaiting_payment_order_count: orders.filter((order) => !order.exactPayment).length,
      with_valid_dte_order_count: withValidDte,
      without_valid_dte_order_count: orders.length - withValidDte,
    },
    fiscal: {
      document_count: documents.length,
      gross_documents: grossDocuments,
      tax_documents: documents.reduce((sum, document) => sum + signedTax(document), 0),
      credit_notes: creditNotes,
      linked_document_count: linkedDocumentCount,
      unlinked_document_count: documents.length - linkedDocumentCount,
    },
    cash: {
      movement_count: payments.length,
      gross_movements: grossMovements,
      fees: payments.reduce((sum, payment) => sum + Math.abs(payment.fees), 0),
      other_deductions: payments.reduce(
        (sum, payment) => sum + payment.gross - Math.abs(payment.fees) - payment.net,
        0,
      ),
      net_movements: payments.reduce((sum, payment) => sum + payment.net, 0),
      reversals: payments.filter((payment) => ["REFUND", "CHARGEBACK"].includes(payment.status))
        .reduce((sum, payment) => sum + Math.abs(payment.net), 0),
      unmatched_movement_count: payments.filter((payment) => payment.status === "UNMATCHED" || !payment.matched).length,
    },
    bridges: {
      commercial_after_reversals: grossSales - creditNotes,
      fiscal_vs_commercial_after_reversals: grossDocuments - (grossSales - creditNotes),
      cash_gross_vs_fiscal: grossMovements - grossDocuments,
    },
  };
};
