import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, FileText, Loader2, RefreshCw, ShoppingBag, WalletCards } from "lucide-react";
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

type PaymentSale = {
  allocated_amount: number;
  orders: Order | null;
};

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

const packIdOf = (order: Order) =>
  order.raw_data?.pack_id ?? order.raw_data?.pack?.id ?? null;

const grossOf = (payment: Payment) =>
  Number(payment.gross_amount ?? payment.amount ?? payment.raw_data?.transaction_amount ?? 0);

export default function PageTrazabilidadPagos() {
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
                  total_amount, status, external_order_id
                )
              )
            )
          )
        `)
        .order("payment_date", { ascending: false })
        .limit(100);

      if (queryError) throw queryError;
      setRows(((data || []) as unknown as Payment[]).filter(
        (payment) => payment.raw_data?.ledger_type !== "LOGICAL_BATCH",
      ));
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
    let withOrder = 0;
    let withDocument = 0;
    let explained = 0;

    for (const payment of rows) {
      const orders = (payment.payment_sales || []).map((link) => link.orders).filter(Boolean) as Order[];
      if (orders.length) withOrder += 1;
      const everyOrderDocumented = orders.length > 0 && orders.every((order) =>
        (order.order_tax_documents || []).some((link) => validDoc(link.tax_documents)),
      );
      if (everyOrderDocumented) withDocument += 1;

      const paymentGross = grossOf(payment);
      const orderGross = orders.reduce((sum, order) => sum + Number(order.gross_amount || 0), 0);
      if (everyOrderDocumented && paymentGross > 0 && Math.abs(paymentGross - orderGross) <= 1) explained += 1;
    }

    return { withOrder, withDocument, explained };
  }, [rows]);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Nav />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1500px] mx-auto px-8 py-8">
          <div className="flex items-start justify-between gap-6 mb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Trazabilidad</p>
              <h1 className="text-2xl font-semibold text-slate-900 mt-1">¿De qué corresponde este pago?</h1>
              <p className="text-sm text-slate-500 mt-2 max-w-3xl">
                Mercado Pago es la fuente financiera. Partimos del payment_id exacto, seguimos a la orden real y desde esa orden llegamos a la boleta de Bsale.
              </p>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Recargar 100
            </button>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs text-slate-500">Pagos cargados</p>
              <p className="text-2xl font-semibold mt-1">{rows.length}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs text-slate-500">Con orden</p>
              <p className="text-2xl font-semibold mt-1">{summary.withOrder}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs text-slate-500">Con boleta/documento</p>
              <p className="text-2xl font-semibold mt-1">{summary.withDocument}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs text-slate-500">Cadena explicada</p>
              <p className="text-2xl font-semibold mt-1">{summary.explained}</p>
            </div>
          </div>

          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="grid grid-cols-[230px_28px_1fr_28px_1fr_120px] gap-3 px-4 py-3 border-b bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <div>Mercado Pago</div><div />
              <div>Orden</div><div />
              <div>Bsale / boleta</div>
              <div>Estado</div>
            </div>

            {error && <div className="p-6 text-sm text-red-600">{error}</div>}
            {loading && rows.length === 0 && (
              <div className="p-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
            )}
            {!loading && !error && rows.length === 0 && (
              <div className="p-10 text-center text-sm text-slate-500">No hay pagos para mostrar.</div>
            )}

            {rows.map((payment) => {
              const orders = (payment.payment_sales || []).map((link) => link.orders).filter(Boolean) as Order[];
              const paymentGross = grossOf(payment);
              const orderGross = orders.reduce((sum, order) => sum + Number(order.gross_amount || 0), 0);
              const grossMatches = orders.length > 0 && paymentGross > 0 && Math.abs(paymentGross - orderGross) <= 1;
              const everyOrderDocumented = orders.length > 0 && orders.every((order) =>
                (order.order_tax_documents || []).some((link) => validDoc(link.tax_documents)),
              );
              const state = orders.length === 0 ? "Sin orden" : !grossMatches ? "Revisar monto" : !everyOrderDocumented ? "Sin boleta" : "Explicado";

              const docs = new Map<string, { doc: TaxDocument; source: string | null; score: number | null }>();
              for (const order of orders) {
                for (const link of order.order_tax_documents || []) {
                  if (validDoc(link.tax_documents) && link.tax_documents) {
                    docs.set(link.tax_documents.id, { doc: link.tax_documents, source: link.match_source, score: link.match_score });
                  }
                }
              }

              return (
                <div key={payment.id} className="grid grid-cols-[230px_28px_1fr_28px_1fr_120px] gap-3 px-4 py-4 border-b last:border-b-0 items-start text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium text-slate-900">
                      <WalletCards className="h-4 w-4 text-slate-400 shrink-0" />
                      {clp(paymentGross)}
                    </div>
                    <div className="font-mono text-xs text-slate-600 mt-1 break-all">{payment.external_payment_id || payment.id}</div>
                    <div className="text-xs text-slate-400 mt-1">{fmtDate(payment.payment_date)} · neto {clp(payment.net_amount)}</div>
                  </div>

                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1" />

                  <div className="space-y-2 min-w-0">
                    {orders.length === 0 ? (
                      <span className="text-slate-400">No encontramos una orden asociada</span>
                    ) : orders.map((order) => (
                      <div key={order.id} className="min-w-0">
                        <div className="flex items-center gap-2">
                          <ShoppingBag className="h-4 w-4 text-slate-400 shrink-0" />
                          <span className="font-medium text-slate-900">{clp(order.gross_amount)}</span>
                          <span className="font-mono text-xs text-slate-500">#{order.order_id}</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1 truncate">{order.product_title || order.customer_name || "Venta Mercado Libre"}</div>
                        {packIdOf(order) && <div className="text-[11px] text-slate-400 mt-0.5">pack {String(packIdOf(order))}</div>}
                      </div>
                    ))}
                    {orders.length > 0 && (
                      <div className={`text-[11px] ${grossMatches ? "text-slate-400" : "text-amber-700"}`}>
                        Pago bruto {clp(paymentGross)} · órdenes {clp(orderGross)}
                      </div>
                    )}
                  </div>

                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1" />

                  <div className="space-y-2 min-w-0">
                    {docs.size === 0 ? (
                      <span className="text-slate-400">Sin documento tributario asociado</span>
                    ) : Array.from(docs.values()).map(({ doc, source, score }) => (
                      <div key={doc.id}>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                          <span className="font-medium text-slate-900">{doc.document_type} Nº {doc.document_number}</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{clp(doc.total_amount)} · {fmtDate(doc.document_date)}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          match {source || "—"}{score != null ? ` · ${score}%` : ""}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                      state === "Explicado" ? "bg-emerald-50 text-emerald-700" :
                      state === "Revisar monto" ? "bg-amber-50 text-amber-700" :
                      "bg-slate-100 text-slate-600"
                    }`}>
                      {state}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-slate-400 mt-4">
            Esta vista no crea conciliaciones: sólo explica las relaciones ya persistidas. Un mismo documento puede respaldar varias órdenes y, por lo tanto, aparecer en más de un pago.
          </p>
        </div>
      </main>
    </div>
  );
}
