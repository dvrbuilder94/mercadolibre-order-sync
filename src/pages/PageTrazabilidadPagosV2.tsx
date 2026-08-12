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
    for (const payment of rows) {
      const orders = (payment.payment_sales || []).map((l) => l.orders).filter(Boolean) as Order[];
      if (orders.some((o) => exactPaymentEvidence(payment, o))) exactPayment += 1;
      const docs = orders.flatMap((o) => (o.order_tax_documents || []).map((l) => l.tax_documents).filter(validDoc)) as TaxDocument[];
      if (docs.length) withDoc += 1;
      if (docs.some((d) => !!d.external_url)) withBsaleUrl += 1;
    }
    return { exactPayment, withDoc, withBsaleUrl };
  }, [rows]);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Nav />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1600px] mx-auto px-8 py-8">
          <div className="flex items-start justify-between gap-6 mb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Trazabilidad auditable</p>
              <h1 className="text-2xl font-semibold text-slate-900 mt-1">Pago → orden → documento Bsale</h1>
              <p className="text-sm text-slate-500 mt-2 max-w-4xl">
                Esta vista muestra la relación persistida y también la evidencia. No basta con decir “linkeado”: puedes revisar payment_id, monto, order_id, fuente del match y abrir el documento real de Bsale cuando su URL fue guardada.
              </p>
            </div>
            <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Recargar 100
            </button>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-6">
            <Stat label="Pagos cargados" value={rows.length} />
            <Stat label="payment_id exacto" value={summary.exactPayment} />
            <Stat label="Con documento" value={summary.withDoc} />
            <Stat label="Con URL Bsale" value={summary.withBsaleUrl} />
          </div>

          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="grid grid-cols-[240px_28px_1fr_28px_1.25fr] gap-3 px-4 py-3 border-b bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <div>Mercado Pago</div><div /><div>Orden + evidencia</div><div /><div>Bsale / documento + evidencia</div>
            </div>
            {error && <div className="p-6 text-sm text-red-600">{error}</div>}
            {loading && rows.length === 0 && <div className="p-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>}

            {rows.map((payment) => {
              const links = payment.payment_sales || [];
              const orders = links.map((l) => l.orders).filter(Boolean) as Order[];
              const paymentGross = grossOf(payment);
              return (
                <div key={payment.id} className="grid grid-cols-[240px_28px_1fr_28px_1.25fr] gap-3 px-4 py-5 border-b last:border-b-0 items-start text-sm">
                  <div>
                    <div className="flex items-center gap-2 font-medium"><WalletCards className="h-4 w-4 text-slate-400" />{clp(paymentGross)}</div>
                    <div className="font-mono text-xs text-slate-700 mt-1 break-all">payment_id {payment.external_payment_id || "—"}</div>
                    <div className="text-xs text-slate-400 mt-1">{fmtDate(payment.payment_date)} · neto {clp(payment.net_amount)} · comisión {clp(payment.fees_amount)}</div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1" />
                  <div className="space-y-3">
                    {orders.length === 0 ? <span className="text-slate-400">Sin orden asociada</span> : links.map((link) => {
                      const order = link.orders;
                      if (!order) return null;
                      const exact = exactPaymentEvidence(payment, order);
                      return <div key={order.id} className="rounded-md border p-3">
                        <div className="flex items-center gap-2"><ShoppingBag className="h-4 w-4 text-slate-400" /><span className="font-medium">{clp(order.gross_amount)}</span><span className="font-mono text-xs text-slate-500">#{order.order_id}</span></div>
                        <div className="text-xs text-slate-500 mt-1">{order.product_title || order.customer_name || "Venta Mercado Libre"}</div>
                        {packIdOf(order) && <div className="text-[11px] text-slate-400 mt-1">pack_id {String(packIdOf(order))}</div>}
                        <div className={`text-xs mt-2 font-medium ${exact ? "text-emerald-700" : "text-amber-700"}`}>
                          {exact ? "✓ payment_id aparece en esta orden" : "⚠ payment_id no aparece explícitamente en raw_data de esta orden"}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1">payment_sales asigna {clp(link.allocated_amount)} a esta orden</div>
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
                        return <div key={link.id} className="rounded-md border p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" /><span className="font-medium">{doc.document_type} Nº {doc.document_number}</span></div>
                            {doc.external_url ? <a href={doc.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">Abrir en Bsale <ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-[11px] text-amber-700">Sin URL Bsale guardada</span>}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{clp(doc.total_amount)} · {fmtDate(doc.document_date)} · estado {doc.status || "—"}</div>
                          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-500">
                            <div>order_id Bsale: <span className="font-mono text-slate-700">{doc.external_order_id || "—"}</span></div>
                            <div>ID Bsale: <span className="font-mono text-slate-700">{doc.external_document_id || "—"}</span></div>
                            <div>fuente: <span className="text-slate-700">{link.match_source || "—"}</span></div>
                            <div>score: <span className="text-slate-700">{link.match_score != null ? `${link.match_score}%` : "—"}</span></div>
                            <div>sistema: <span className="text-slate-700">{doc.erp || doc.external_system || "—"}</span></div>
                            <div>canal: <span className="text-slate-700">{doc.detected_channel || doc.sales_channel || "—"}</span></div>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-2">Vínculo persistido: orden #{order.order_id} → documento {doc.document_number}</div>
                        </div>;
                      });
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-400 mt-4">Una URL sólo aparece si Bsale la entregó y quedó guardada en tax_documents.external_url. La vista no construye URLs ni crea matches.</p>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className="text-2xl font-semibold mt-1">{value}</p></div>;
}
