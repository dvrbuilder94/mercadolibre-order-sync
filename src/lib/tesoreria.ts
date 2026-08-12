import { CHANNEL_LABEL } from "@/lib/constants";
import { orderHasDoc } from "@/lib/taxDocs";

export const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(n || 0);

export interface TesoreriaDocument {
  id: string;
  number: string;
  url: string | null;
  status: string | null;
  type: string | null;
}

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
    raw_data: Record<string, any> | null;
    order_tax_documents: {
      id: string;
      tax_documents: {
        id: string;
        status: string | null;
        document_number: string;
        external_url: string | null;
        document_type: string | null;
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
  otherDeductions: number;
  net: number;
  status: string;
  method: string;
  methodBrand: string | null;
  installments: number | null;
  channels: string[];
  releaseDate: string | null;
  liberado: boolean;
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
    packId: string | null;
    documents: TesoreriaDocument[];
  }[];
  allocatedSum: number;
  linkedGrossSum: number;
  docsOk: number;
  documents: TesoreriaDocument[];
  packIds: string[];
  matchState: "matched" | "partial" | "orphan";
}

const isLogicalBatch = (p: TesoreriaPaymentRaw) =>
  p.raw_data?.ledger_type === "LOGICAL_BATCH";

/** Drop old synthetic settlement rows. They are not real Mercado Pago movements. */
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

const moneyMatches = (a: number, b: number) => {
  const ref = Math.max(Math.abs(a), Math.abs(b));
  const tolerance = Math.max(ref * 0.005, 1);
  return Math.abs(a - b) <= tolerance;
};

const docsFromOrder = (order: TesoreriaSaleLink["orders"]): TesoreriaDocument[] => {
  if (!order) return [];
  const docs = new Map<string, TesoreriaDocument>();
  for (const link of order.order_tax_documents || []) {
    const doc = link.tax_documents;
    if (!doc || doc.status === "voided") continue;
    docs.set(doc.id, {
      id: doc.id,
      number: doc.document_number,
      url: doc.external_url,
      status: doc.status,
      type: doc.document_type,
    });
  }
  return Array.from(docs.values());
};

export const toTesoreriaPayment = (p: TesoreriaPaymentRaw): TesoreriaPayment => {
  const links = p.payment_sales || [];
  const sales = links
    .filter((l) => l.orders)
    .map((l) => {
      const order = l.orders!;
      const packRaw = order.raw_data?.pack_id;
      return {
        id: order.id,
        orderId: order.order_id,
        channel: order.channel,
        customer: order.customer_name,
        title: order.product_title,
        allocated: l.allocated_amount || 0,
        gross: order.gross_amount,
        hasDoc: orderHasDoc(order.order_tax_documents),
        packId: packRaw == null ? null : String(packRaw),
        documents: docsFromOrder(order),
      };
    });

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

  const allocatedSum = sales.reduce((sum, sale) => sum + sale.allocated, 0);
  const linkedGrossSum = sales.reduce((sum, sale) => sum + (sale.gross || 0), 0);
  const gross = p.gross_amount || 0;
  const fees = p.fees_amount || 0;
  const net = p.net_amount || 0;
  const isReversal = p.status === "REFUND" || p.status === "CHARGEBACK" || net < 0;

  let matchState: TesoreriaPayment["matchState"] = "orphan";
  if (sales.length > 0) {
    const netConsistent = net !== 0 && moneyMatches(allocatedSum, net);
    // Para pagos normales, no basta que el neto asignado cierre: el bruto del
    // payment debe corresponder al bruto de las ventas vinculadas. Esto evita
    // marcar como "Completo" un payment prorrateado artificialmente a todo un pack.
    // Reversas se validan por su asignación neta porque pueden ser parciales.
    const grossConsistent = isReversal || (gross !== 0 && moneyMatches(linkedGrossSum, gross));
    matchState = netConsistent && grossConsistent ? "matched" : "partial";
  }

  const documents = new Map<string, TesoreriaDocument>();
  for (const sale of sales) for (const doc of sale.documents) documents.set(doc.id, doc);
  const packIds = Array.from(new Set(sales.map((sale) => sale.packId).filter(Boolean) as string[]));
  const otherDeductions = !isReversal ? Math.max(0, gross - fees - net) : 0;

  return {
    id: p.id,
    paymentId: p.external_payment_id || p.id.slice(0, 8),
    provider: providerLabel(p.payment_provider),
    paymentDate: p.payment_date,
    gross,
    fees,
    otherDeductions,
    net,
    status: p.status || "—",
    method: methodLabel(type),
    methodBrand: brand,
    installments,
    channels,
    releaseDate: release,
    liberado: isReversal || (release ? new Date(release) <= new Date() : false),
    exactRelease,
    sales,
    allocatedSum,
    linkedGrossSum,
    docsOk: sales.filter((s) => s.hasDoc).length,
    documents: Array.from(documents.values()),
    packIds,
    matchState,
  };
};

export const channelLabel = (ch: string) => CHANNEL_LABEL[ch] ?? ch;
