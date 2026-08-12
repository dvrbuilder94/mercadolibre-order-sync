import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ExternalLink, FileText, Loader2, RefreshCw, ShoppingBag, WalletCards } from "lucide-react";
import { Nav } from "@/components/Nav";
import { supabase } from "@/integrations/supabase/client";
import { clp } from "@/lib/tesoreria";

type TaxDocument = {
  id: string;
  document_number: string;
  document_type: string;
  document_date: string;
  total_amount: number;
  status: string | null;
  external_order_id: string | null;
  external_document_id: string | null;
  external_system: string | null;
  external_url: string | null;
  erp: string | null;
  detected_channel: string | null;
  sales_channel: string | null;
};

type TaxLink = {
  id: string;
  allocated_amount: number | null;
  match_source: string | null;
  match_score: number | null;
  tax_documents: TaxDocument | null;
};

type Order = {
  id: string;
  order_id: string;
  gross_amount: number | null;
  product_title: string | null;
  customer_name: string | null;
  raw_data: Record<string, any> | null;
  order_tax_documents: TaxLink[] | null;
};

type PaymentSale = { allocated_amount: number; orders: Order | null };

type Payment = {
  id: string;
  external_payment_id: string | null;
  payment_provider: string | null;
  payment_date: string;
  gross_amount: number | null;
  amount: number | null;
  net_amount: number | null;
  fees_amount: number | null;
  status: string | null;
  raw_data: Record<string, any> | null;
  payment_sales: PaymentSale[] | null;
};

type DocEvidence = {
  label: string;
  tone: "strong" | "pack" | "heuristic" | "warning";
  detail: string;
};

const fmtDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("es-CL");
};

const validDoc = (doc: TaxDocument | null) =>
  !!doc && !["cancelled", "anulada", "void"].includes(String(doc.status || "").toLowerCase());

const packIdOf = (order: Order) => order.raw_data?.pack_id ?? order.raw_data?.pack?.id ?? null;
const grossOf = (payment: Payment) => Number(payment.gross_amount ?? payment.amount ?? payment.raw_data?.transaction_amount ?? 0);

function paymentIdsOf(order: Order): string[] {
  const raw = order.raw_data || {};
  const ids = new Set<string>();
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  for (const p of payments) {
    const id = p?.id ?? p?.payment_id;
    if (id != null) ids.add(String(id));
  }
  if (raw.payment_id != null) ids.add(String(raw.payment_id));
  if (raw.payment?.id != null) ids.add(String(raw.payment.id));
  return Array.from(ids);
}

function exactPaymentEvidence(payment: Payment, order: Order) {
  const paymentId = String(payment.external_payment_id || "");
  return paymentId !== "" && paymentIdsOf(order).includes(paymentId);
}

function docEvidence(order: Order, link: TaxLink): DocEvidence {
  const doc = link.tax_documents;
  if (!doc) return { label: "Sin evidencia", tone: "warning", detail: "No hay documento cargado." };

  const externalOrderId = String(doc.external_order_id || "");
  const orderId = String(order.order_id || "");
  const packId = packIdOf(order) != null ? String(packIdOf(order)) : "";
  const source = String(link.match_source || "").toUpperCase();

  if (externalOrderId && externalOrderId === orderId) {
    return { label: "Match fuerte · order_id exacto", tone: "strong", detail: `Bsale referencia exactamente la orden ${orderId}.` };
  }

  if (externalOrderId && packId && externalOrderId === packId) {
    return { label: "Match fuerte · pack_id explícito", tone: "pack", detail: `Bsale referencia el pack ${packId} que contiene esta orden.` };
  }

  if (source.includes("HARD_ORDER_ID")) {
    return { label: "Match fuerte declarado", tone: "strong", detail: `El motor registró ${link.match_source}; revisar referencia Bsale si difiere visualmente.` };
  }

  if (source.includes("HARD_PACK") || source.includes("PACK_SIBLING") || source.includes("PACK_ID")) {
    return { label: "Match por pack", tone: "pack", detail: `El motor registró ${link.match_source}; la boleta puede consolidar varias órdenes del mismo pack.` };
  }

  if (externalOrderId && externalOrderId !== orderId && (!packId || externalOrderId !== packId)) {
    return {
      label: "⚠ Referencia Bsale distinta",
      tone: "warning",
      detail: `Bsale=${externalOrderId} · order_id=${orderId}${packId ? ` · pack_id=${packId}` : ""}. El vínculo requiere justificación adicional.`,
    };
  }

  return {
    label: "Match heurístico / sin clave fuerte visible",
    tone: "heuristic",
    detail: `Fuente ${link.match_source || "—"}${link.match_score != null ? ` · score ${link.match_score}%` : ""}.`,
  };
}

function unexplainedFinancialAmount(payment: Payment) {
  const gross = grossOf(payment);
  const fees = Math.abs(Number(payment.fees_amount || 0));
  const net = Number(payment.net_amount || 0);
  return Math.round((gross - fees - net) * 100) / 100;
}

function evidenceClass(tone: DocEvidence["tone"]) {
  if (tone === "strong") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (tone === "pack") return "bg-blue-50 text-blue-700 border-blue-200";
  if (tone === "warning") return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

export default function PageTrazabilidadPagosV2() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from("payments")
        .select(`
          id, external_payment_id, payment_provider, payment_date,
          gross_amount, amount, net_amount, fees_amount, status, raw_data,
          payment_sales (
            allocated_amount,
            orders (
              id, order_id, gross_amount, product_title, customer_name, raw_data,
              order_tax_documents (
                id, allocated_amount, match_source, match_score,
                tax_documents (
                  id, document_number, document_type, document_date,
                  total_amount, status, external_order_id, external_document_id,
                  external_system, external_url, erp, detected_channel, sales_channel
                )
              )
            )
          )
        `)
        .order("payment_date", { ascending: false })
        .limit(100);
      if (queryError) throw queryError;
      setRows(((data || []) as unknown as Payment[]).filter((p) => p.raw_data?.ledger_type !== "LOGICAL_BATCH"));
    } catch (e: any) {
      console.error("Error cargando trazabilidad de pagos:", e);
      setRows([]);
      setError(e?.message || "No se pudo cargar la trazabilidad.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    let exactPayment = 0;
    let withDoc = 0;
    let withBsaleUrl = 0;
    let suspiciousDoc = 0;
    let financialGap = 0;
    for (const payment of rows) {
      const orders = (payment.payment_sales || []).map((l) => l.orders).filter(Boolean) as Order[];
      if (orders.some((o) => exactPaymentEvidence(payment, o))) exactPayment += 1;
      const docLinks = orders.flatMap((o) => (o.order_tax_documents || []).filter((l) => validDoc(l.tax_documents)).map((l) => ({ order: o, link: l })));
      if (docLinks.length) withDoc += 1;
      if (docLinks.some(({ link }) => !!link.tax_documents?.external_url)) withBsaleUrl += 1;
      if (docLinks.some(({ order, link }) => docEvidence(order, link).tone === "warning")) suspiciousDoc += 1;
      if (Math.abs(unexplainedFinancialAmount(payment)) > 1) financialGap += 1;
    }
    return { exactPayment, withDoc, withBsaleUrl, suspiciousDoc, financialGap };
  }, [rows]);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Nav />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1700px] mx-auto px-8 py-8">
          <div className="flex items-start justify-between gap-6 mb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Trazabilidad auditable</p>
              <h1 className="text-2xl font-semibold text-slate-900 mt-1">Pago → orden → documento Bsale</h1>
              <p className="text-sm text-slate-500 mt-2 max-w-5xl">
                La vista separa evidencia financiera y tributaria. Muestra qué payment_id prueba la orden, qué referencia trae Bsale, si coincide con order_id o pack_id y si el desglose bruto → comisión → neto deja montos sin explicar.
              </p>
            </div>
            <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Recargar 100
            </button>
          </div>

          <div className="grid grid-cols-6 gap-3 mb-6">
            <Stat label="Pagos cargados" value={rows.length} />
            <Stat label="payment_id exacto" value={summary.exactPayment} />
            <Stat label="Con documento" value={summary.withDoc} />
            <Stat label="Con URL Bsale" value={summary.withBsaleUrl} />
            <Stat label="Ref. Bsale a revisar" value={summary.suspiciousDoc} />
            <Stat label="Brecha financiera" value={summary.financialGap} />
          </div>

          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="grid grid-cols-[250px_28px_1fr_28px_1.4fr] gap-3 px-4 py-3 border-b bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <div>Mercado Pago</div><div /><div>Orden + evidencia financiera</div><div /><div>Bsale / documento + evidencia tributaria</div>
            </div>
            {error && <div className="p-6 text-sm text-red-600">{error}</div>}
            {loading && rows.length === 0 && <div className="p-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>}

            {rows.map((payment) => {
              const links = payment.payment_sales || [];
              const orders = links.map((l) => l.orders).filter(Boolean) as Order[];
              const paymentGross = grossOf(payment);
              const financialGap = unexplainedFinancialAmount(payment);
              return (
                <div key={payment.id} className="grid grid-cols-[250px_28px_1fr_28px_1.4fr] gap-3 px-4 py-5 border-b last:border-b-0 items-start text-sm">
                  <div>
                    <div className="flex items-center gap-2 font-medium"><WalletCards className="h-4 w-4 text-slate-400" />{clp(paymentGross)}</div>
                    <div className="font-mono text-xs text-slate-700 mt-1 break-all">payment_id {payment.external_payment_id || "—"}</div>
                    <div className="text-xs text-slate-400 mt-1">{fmtDate(payment.payment_date)} · neto {clp(payment.net_amount)} · comisión {clp(payment.fees_amount)}</div>
                    <div className={`mt-2 rounded border px-2 py-1 text-[11px] ${Math.abs(financialGap) <= 1 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-800 border-amber-200"}`}>
                      {Math.abs(financialGap) <= 1
                        ? "✓ Bruto − comisión = neto"
                        : `⚠ ${clp(Math.abs(financialGap))} no explicado entre bruto, comisión y neto`}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1" />
                  <div className="space-y-3">
                    {orders.length === 0 ? <span className="text-slate-400">Sin orden asociada</span> : links.map((link) => {
                      const order = link.orders;
                      if (!order) return null;
                      const exact = exactPaymentEvidence(payment, order);
                      const packId = packIdOf(order);
                      return <div key={order.id} className="rounded-md border p-3">
                        <div className="flex items-center gap-2"><ShoppingBag className="h-4 w-4 text-slate-400" /><span className="font-medium">{clp(order.gross_amount)}</span></div>
                        <div className="mt-2 grid grid-cols-1 gap-1 text-[11px]">
                          <div>order_id Quadra: <span className="font-mono text-slate-800">{order.order_id}</span></div>
                          <div>pack_id MELI: <span className="font-mono text-slate-700">{packId != null ? String(packId) : "—"}</span></div>
                          <div>payment_sales neto asignado: <span className="font-medium text-slate-700">{clp(link.allocated_amount)}</span></div>
                        </div>
                        <div className="text-xs text-slate-500 mt-2">{order.product_title || order.customer_name || "Venta Mercado Libre"}</div>
                        <div className={`text-xs mt-2 font-medium ${exact ? "text-emerald-700" : "text-amber-700"}`}>
                          {exact ? "✓ payment_id exacto aparece en la orden" : "⚠ payment_id no aparece explícitamente en raw_data de esta orden"}
                        </div>
                      </div>;
                    })}
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1" />
                  <div className="space-y-3">
                    {orders.length === 0 ? <span className="text-slate-400">—</span> : orders.map((order) => {
                      const docs = (order.order_tax_documents || []).filter((l) => validDoc(l.tax_documents));
                      if (!docs.length) return <div key={order.id} className="rounded-md border border-dashed p-3 text-slate-400">Orden #{order.order_id}: sin documento tributario</div>;
                      return docs.map((link) => {
                        const doc = link.tax_documents!;
                        const evidence = docEvidence(order, link);
                        const packId = packIdOf(order);
                        return <div key={link.id} className="rounded-md border p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" /><span className="font-medium">{doc.document_type} Nº {doc.document_number}</span></div>
                            {doc.external_url ? <a href={doc.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">Abrir en Bsale <ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-[11px] text-amber-700">Sin URL Bsale guardada</span>}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{clp(doc.total_amount)} · {fmtDate(doc.document_date)} · estado {doc.status || "—"}</div>
                          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-500">
                            <div>order_id Quadra: <span className="font-mono text-slate-700">{order.order_id}</span></div>
                            <div>referencia Bsale: <span className="font-mono text-slate-700">{doc.external_order_id || "—"}</span></div>
                            <div>pack_id MELI: <span className="font-mono text-slate-700">{packId != null ? String(packId) : "—"}</span></div>
                            <div>ID documento Bsale: <span className="font-mono text-slate-700">{doc.external_document_id || "—"}</span></div>
                            <div>match_source: <span className="text-slate-700">{link.match_source || "—"}</span></div>
                            <div>match_score: <span className="text-slate-700">{link.match_score != null ? `${link.match_score}%` : "—"}</span></div>
                            <div>sistema: <span className="text-slate-700">{doc.erp || doc.external_system || "—"}</span></div>
                            <div>canal: <span className="text-slate-700">{doc.detected_channel || doc.sales_channel || "—"}</span></div>
                          </div>
                          <div className={`mt-3 rounded border px-2.5 py-2 text-[11px] ${evidenceClass(evidence.tone)}`}>
                            <div className="font-semibold">{evidence.label}</div>
                            <div className="mt-0.5 opacity-90">{evidence.detail}</div>
                          </div>
                        </div>;
                      });
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-400 mt-4">Una URL sólo aparece si Bsale la entregó y quedó guardada en tax_documents.external_url. La vista no construye URLs ni crea matches. Una diferencia entre bruto, comisión y neto se marca como brecha, pero no se etiqueta automáticamente como envío, cupón u otro cargo sin evidencia del proveedor.</p>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className="text-2xl font-semibold mt-1">{value}</p></div>;
}
