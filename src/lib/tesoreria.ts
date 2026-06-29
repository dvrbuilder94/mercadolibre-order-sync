import { CHANNEL_LABEL } from "@/lib/constants";
import { orderHasDoc } from "@/lib/taxDocs";

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
    order_tax_documents: { id: string; tax_documents: { status: string | null } | null }[] | null;
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
  status: string;
  method: string;
  methodBrand: string | null;
  installments: number | null;
  channels: string[];
  releaseDate: string | null;
  liberado: boolean;
  sales: {
    id: string;
    orderId: string;
    channel: string | null;
    customer: string | null;
    title: string | null;
    allocated: number;
    gross: number | null;
    hasDoc: boolean;
  }[];
  allocatedSum: number;
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
  const type =
    raw?.payment_type ||
    raw?.payment_type_id ||
    raw?.payment_method_type ||
    orderMethod ||
    null;
  const brand =
    raw?.payment_method_id ||
    raw?.payment_method_brand ||
    raw?.card?.payment_method?.id ||
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
    }));
  const channels = Array.from(
    new Set(links.map((l) => l.orders?.channel).filter(Boolean) as string[]),
  );
  const releaseDates = links
    .map((l) => l.orders?.money_release_date)
    .filter(Boolean) as string[];
  const release =
    releaseDates.length > 0
      ? releaseDates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
      : null;
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
    const tolerance = Math.max(ref * 0.02, 100);
    matchState =
      ref > 0 && Math.abs(allocatedSum - ref) <= tolerance ? "matched" : "partial";
  }

  return {
    id: p.id,
    paymentId: p.external_payment_id || p.id.slice(0, 8),
    provider: providerLabel(p.payment_provider),
    paymentDate: p.payment_date,
    gross: p.gross_amount || 0,
    fees: p.fees_amount || 0,
    net,
    status: p.status || "—",
    method: methodLabel(type),
    methodBrand: brand,
    installments,
    channels,
    releaseDate: release,
    liberado: release ? new Date(release) <= new Date() : true,
    sales,
    allocatedSum,
    docsOk: sales.filter((s) => s.hasDoc).length,
    matchState,
  };
};

export const channelLabel = (ch: string) => CHANNEL_LABEL[ch] ?? ch;

export const periodRange = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0, 23, 59, 59);
  return { from, to };
};
