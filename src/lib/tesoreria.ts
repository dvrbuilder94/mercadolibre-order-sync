import { CHANNEL_LABEL } from "@/lib/constants";
import { linkIsVigente, orderHasDoc } from "@/lib/taxDocs";

export const VAT_RATE = 0.19;

/** IVA incluido en un monto bruto con IVA (19%). */
export const vatFromGross = (gross: number) =>
  Math.round(gross - gross / (1 + VAT_RATE));

export interface TesoreriaDoc {
  id: string;
  type: string | null;
  number: string | null;
  url: string | null;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  boleta: "Boleta",
  factura: "Factura",
  factura_exenta: "Factura exenta",
  nota_credito: "Nota de crédito",
  nota_debito: "Nota de débito",
};

export const docTypeLabel = (t: string | null) =>
  (t && DOC_TYPE_LABEL[t]) || t || "Documento";

export const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(n || 0);

export interface TesoreriaSaleLink {
  allocated_amount: number;
  orders: {
    id: string;
    order_id: string;
    channel: string | null;
    customer_name: string | null;
    product_title: string | null;
    gross_amount: number | null;
    order_date: string | null;
    money_release_date: string | null;
    installments: number | null;
    payment_method: string | null;
    has_exact_data: boolean | null;
    order_tax_documents: {
      id: string;
      tax_documents: {
        id?: string;
        status: string | null;
        document_type?: string | null;
        document_number?: string | null;
        external_url?: string | null;
      } | null;
    }[] | null;
  } | null;
}

export interface TesoreriaPaymentRaw {
  id: string;
  external_payment_id: string | null;
  payment_provider: string | null;
  payment_date: string;
  net_amount: number | null;
  fees_amount: number | null;
  gross_amount: number | null;
  amount: number | null;
  status: string | null;
  raw_data: Record<string, any> | null;
  payment_sales: TesoreriaSaleLink[] | null;
}

export interface TesoreriaPayment {
  id: string;
  paymentId: string;
  provider: string;
  paymentDate: string;
  gross: number;
  fees: number;
  net: number;
  /** IVA incluido en el bruto (19%). */
  vat: number;
  status: string;
  method: string;
  methodBrand: string | null;
  installments: number | null;
  channels: string[];
  releaseDate: string | null;
  liberado: boolean;
  // La fecha de liberación es exacta solo cuando MercadoPago la confirmó
  // (has_exact_data). Si alguna venta del pago no está confirmada, es estimada.
  exactRelease: boolean;
  sales: {
    id: string;
    orderId: string;
    channel: string | null;
    customer: string | null;
    title: string | null;
    allocated: number;
    gross: number | null;
    hasDoc: boolean;
    docs: TesoreriaDoc[];
  }[];
  allocatedSum: number;
  /** Documentos tributarios vigentes de todas las ventas del pago (sin repetir). */
  docs: TesoreriaDoc[];
  // Cuántas de las ventas de este pago ya tienen documento tributario vigente.
  docsOk: number;
  matchState: "matched" | "partial" | "orphan";
}

const isLogicalBatch = (p: TesoreriaPaymentRaw) =>
  p.raw_data?.ledger_type === "LOGICAL_BATCH";

/** Drop sync-meli-settlements synthetic "batch" rows — they are not real MP deposits. */
export const onlyRealMpPayments = (rows: TesoreriaPaymentRaw[]) =>
  rows.filter((p) => !isLogicalBatch(p));

export const providerLabel = (p: string | null) => {
  if (!p) return "—";
  if (p === "MERCADOPAGO") return "MercadoPago";
  if (p === "TRANSBANK") return "Transbank";
  return p;
};

const METHOD_TYPE_LABEL: Record<string, string> = {
  account_money: "Dinero en cuenta",
  credit_card: "Tarjeta de crédito",
  debit_card: "Tarjeta de débito",
  consumer_credits: "Mercado Crédito",
  ticket: "Cupón",
  bank_transfer: "Transferencia",
};

export const methodLabel = (type: string | null) =>
  (type && METHOD_TYPE_LABEL[type]) || type || "—";

/** Pulls the most informative payment method label we can from raw_data or the linked order. */
const extractMethod = (raw: any, orderMethod: string | null) => {
  const payment = raw?.mp_payment || raw;
  const type =
    payment?.payment_type ||
    payment?.payment_type_id ||
    payment?.payment_method_type ||
    orderMethod ||
    null;
  const brand =
    payment?.payment_method_id ||
    payment?.payment_method_brand ||
    payment?.card?.payment_method?.id ||
    null;
  return { type, brand };
};

export const toTesoreriaPayment = (p: TesoreriaPaymentRaw): TesoreriaPayment => {
  const links = p.payment_sales || [];
  const sales = links
    .filter((l) => l.orders)
    .map((l) => ({
      id: l.orders!.id,
      orderId: l.orders!.order_id,
      channel: l.orders!.channel,
      customer: l.orders!.customer_name,
      title: l.orders!.product_title,
      allocated: l.allocated_amount || 0,
      gross: l.orders!.gross_amount,
      hasDoc: orderHasDoc(l.orders!.order_tax_documents),
      docs: (l.orders!.order_tax_documents ?? [])
        .filter(linkIsVigente)
        .map((link) => ({
          id: link.tax_documents?.id || link.id,
          type: link.tax_documents?.document_type ?? null,
          number: link.tax_documents?.document_number ?? null,
          url: link.tax_documents?.external_url ?? null,
        })),
    }));
  const channels = Array.from(
    new Set(links.map((l) => l.orders?.channel).filter(Boolean) as string[]),
  );
  const rawRelease =
    p.raw_data?.money_release_date ||
    p.raw_data?.mp_payment?.money_release_date ||
    null;
  const releaseDates = links
    .map((l) => l.orders?.money_release_date)
    .filter(Boolean) as string[];
  if (rawRelease) releaseDates.push(rawRelease);
  const release =
    releaseDates.length > 0
      ? releaseDates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
      : null;
  const linkedOrders = links.filter((l) => l.orders);
  const exactRelease =
    linkedOrders.length > 0 && linkedOrders.every((l) => !!l.orders!.has_exact_data);
  const orderMethod =
    links.find((l) => l.orders?.payment_method)?.orders?.payment_method || null;
  const installments =
    links.find((l) => l.orders?.installments)?.orders?.installments ?? null;
  const { type, brand } = extractMethod(p.raw_data, orderMethod);

  const allocatedSum = sales.reduce((s, x) => s + x.allocated, 0);
  const net = p.net_amount || 0;
  let matchState: TesoreriaPayment["matchState"] = "orphan";
  if (sales.length > 0) {
    const ref = net || p.amount || 0;
    const tolerance = Math.max(Math.abs(ref) * 0.02, 100);
    matchState =
      ref !== 0 && Math.abs(allocatedSum - ref) <= tolerance ? "matched" : "partial";
  }

  const isReversal = p.status === "REFUND" || p.status === "CHARGEBACK";

  return {
    id: p.id,
    paymentId: p.external_payment_id || p.id.slice(0, 8),
    provider: providerLabel(p.payment_provider),
    paymentDate: p.payment_date,
    gross: p.gross_amount || 0,
    fees: p.fees_amount || 0,
    net,
    vat: vatFromGross(p.gross_amount || 0),
    status: p.status || "—",
    method: methodLabel(type),
    methodBrand: brand,
    installments,
    channels,
    releaseDate: release,
    // A refund/chargeback is effective when its negative ledger movement is
    // recorded. Other movements without a confirmed release date stay pending.
    liberado: isReversal || (release ? new Date(release) <= new Date() : false),
    exactRelease,
    sales,
    allocatedSum,
    docs: Array.from(
      new Map(sales.flatMap((s) => s.docs).map((d) => [d.id, d])).values(),
    ),
    docsOk: sales.filter((s) => s.hasDoc).length,
    matchState,
  };
};

export const channelLabel = (ch: string) => CHANNEL_LABEL[ch] ?? ch;
