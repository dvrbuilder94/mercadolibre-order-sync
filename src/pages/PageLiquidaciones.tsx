import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, RefreshCw, Loader2, ShieldCheck, ChevronDown, ChevronUp,
} from "lucide-react";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};
const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};
const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 })
    .format(n || 0);

const PAGE_SIZE = 50;

// Fila cruda: un pago real de MercadoPago (payments) con las órdenes que
// cubre (payment_sales → orders) y si cada una ya tiene documento tributario.
interface PaySaleOrder {
  id: string; order_id: string; channel: string | null; product_title: string | null;
  gross_amount: number | null; money_release_date: string | null;
  order_tax_documents: { id: string }[] | null;
}
interface PaymentRow {
  id: string;
  external_payment_id: string | null;
  payment_date: string;
  net_amount: number | null;
  fees_amount: number | null;
  gross_amount: number | null;
  payment_sales: { allocated_amount: number; orders: PaySaleOrder | null }[] | null;
  raw_data: { ledger_type?: string } | null;
}

// sync-meli-settlements (no expuesto en ningún botón hoy, pero sigue desplegado
// y alcanzable) escribe filas en payments que NO vienen de MercadoPago: agrupa
// nuestras propias órdenes por fecha de liberación y las re-empaqueta como un
// "pago" sintético (external_payment_id = MELI_<seller>_<fecha>, monto = Σ
// ventas del día). Se marca a sí mismo con raw_data.ledger_type = LOGICAL_BATCH.
// Solo sync-meli-payment-details (y sync-payments) traen datos reales de la
// API de pagos de MercadoPago — hay que excluir lo sintético explícitamente,
// porque ambos comparten la misma tabla y el mismo payment_provider.
const isRealMpPayment = (p: PaymentRow) => p.raw_data?.ledger_type !== "LOGICAL_BATCH";

// Unidad de liquidación derivada — lo que de verdad le importa al usuario:
// cuánto le depositaron, por qué venta(s), y si ya está respaldado con
// documento tributario y liberado en su saldo.
interface Liquidacion {
  key: string;
  externalPaymentId: string | null;
  paymentDate: string;
  net: number;
  fees: number;
  gross: number;
  channels: string[];
  orders: { id: string; orderId: string; title: string | null; amount: number; hasDoc: boolean }[];
  docsOk: number;
  liberado: boolean;
  latestRelease: string | null;
}

const toLiquidacion = (p: PaymentRow): Liquidacion => {
  const links = p.payment_sales || [];
  const orders = links
    .filter((l) => l.orders)
    .map((l) => ({
      id: l.orders!.id, orderId: l.orders!.order_id, title: l.orders!.product_title,
      amount: l.allocated_amount, hasDoc: (l.orders!.order_tax_documents || []).length > 0,
    }));
  const channels = Array.from(new Set(links.map((l) => l.orders?.channel).filter(Boolean) as string[]));
  const releaseDates = links.map((l) => l.orders?.money_release_date).filter(Boolean) as string[];
  const latestRelease = releaseDates.length > 0
    ? releaseDates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;
  return {
    key: p.id,
    externalPaymentId: p.external_payment_id,
    paymentDate: p.payment_date,
    net: p.net_amount || 0,
    fees: p.fees_amount || 0,
    gross: p.gross_amount || 0,
    channels, orders,
    docsOk: orders.filter((o) => o.hasDoc).length,
    liberado: latestRelease ? new Date(latestRelease) <= new Date() : true,
    latestRelease,
  };
};

interface OrphanResult {
  totalChecked: number; unmatchedCount: number; unmatchedAmount: number;
  unmatched: { id: string; amount: number; date_approved: string }[];
}

export default function PageLiquidaciones() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<OrphanResult | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const PAGE = 1000;
      let offset = 0;
      const acc: PaymentRow[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("payments")
          .select(`
            id, external_payment_id, payment_date, net_amount, fees_amount, gross_amount, raw_data,
            payment_sales (
              allocated_amount,
              orders ( id, order_id, channel, product_title, gross_amount, money_release_date,
                       order_tax_documents ( id ) )
            )
          `)
          .eq("payment_provider", "MERCADOPAGO")
          .gte("payment_date", from + "T00:00:00")
          .lte("payment_date", to + "T23:59:59")
          .order("payment_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data || []) as unknown as PaymentRow[];
        acc.push(...batch.filter(isRealMpPayment));
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      setRows(acc);
    } catch (e) {
      console.error("Error cargando liquidaciones:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchRows(); }, [fetchRows]);
  useEffect(() => { setPage(0); setAuditResult(null); setAuditOpen(false); }, [period]);

  const liquidaciones = useMemo(() => rows.map(toLiquidacion), [rows]);

  const kpis = useMemo(() => {
    let total = 0, liberado = 0, pendiente = 0, sinDocumento = 0;
    for (const l of liquidaciones) {
      total += l.net;
      if (l.liberado) liberado += l.net; else pendiente += l.net;
      if (l.orders.length > 0 && l.docsOk < l.orders.length) sinDocumento++;
    }
    return { total, liberado, pendiente, sinDocumento, count: liquidaciones.length };
  }, [liquidaciones]);

  const totalPages = Math.max(1, Math.ceil(liquidaciones.length / PAGE_SIZE));
  const pageRows = liquidaciones.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const runAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { from, to } = periodRange(period);
      const { data, error } = await supabase.functions.invoke("check-orphan-payments", {
        body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "error desconocido");
      setAuditResult({
        totalChecked: data.totalChecked, unmatchedCount: data.unmatchedCount,
        unmatchedAmount: data.unmatchedAmount, unmatched: data.unmatched ?? [],
      });
    } catch (e: any) {
      setAuditError(e?.message || "No se pudo consultar MercadoPago");
    } finally {
      setAuditLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">

        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold capitalize w-44 text-center">{periodLabel(period)}</h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={fetchRows} disabled={loading}
            className="ml-2 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* KPIs: lo que de verdad importa de una liquidación — cuánto, cuánto
            ya está liberado, y si falta respaldo tributario. */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Total liquidado</p>
            <p className="text-xl font-bold text-slate-900 tabular-nums">{clp(kpis.total)}</p>
            <p className="text-xs text-slate-400 mt-1">{kpis.count} liquidaciones</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Liberado</p>
            <p className="text-xl font-bold text-green-600 tabular-nums">{clp(kpis.liberado)}</p>
            <p className="text-xs text-slate-400 mt-1">Ya está en tu saldo MercadoPago</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Pendiente de liberación</p>
            <p className="text-xl font-bold text-amber-600 tabular-nums">{clp(kpis.pendiente)}</p>
            <p className="text-xs text-slate-400 mt-1">Aprobado, aún no disponible</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Sin documento</p>
            <p className={`text-xl font-bold tabular-nums ${kpis.sinDocumento > 0 ? "text-red-600" : "text-slate-900"}`}>
              {kpis.sinDocumento}
            </p>
            <p className="text-xs text-slate-400 mt-1">liquidaciones con venta sin DTE</p>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b">
                <th className="px-4 py-2 font-medium">Fecha</th>
                <th className="px-4 py-2 font-medium">Canal</th>
                <th className="px-4 py-2 font-medium">Pago ID</th>
                <th className="px-4 py-2 font-medium text-right">Monto neto</th>
                <th className="px-4 py-2 font-medium">Venta(s)</th>
                <th className="px-4 py-2 font-medium">Documento</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  Sin liquidaciones de MercadoPago en este período. Corre <b>Sync pagos</b> en{" "}
                  <a href="/pipeline" className="text-blue-500 underline">Sincronización</a> si esperabas ver datos acá.
                </td></tr>
              ) : pageRows.map((l) => {
                const isOpen = expanded === l.key;
                const multi = l.orders.length > 1;
                return (
                  <Fragment key={l.key}>
                    <tr className="border-b last:border-0 hover:bg-slate-50 align-top cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : l.key)}>
                      <td className="px-4 py-2 text-slate-500">{l.paymentDate.slice(0, 10)}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-col gap-1">
                          {l.channels.length > 0 ? l.channels.map((ch) => (
                            <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-600"}`}>
                              {CHANNEL_LABEL[ch] ?? ch}
                            </span>
                          )) : <span className="text-slate-300">—</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{l.externalPaymentId || "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{clp(l.net)}</td>
                      <td className="px-4 py-2">
                        <div className="space-y-1">
                          {l.orders.slice(0, multi ? 1 : undefined).map((o) => (
                            <div key={o.id} className="flex items-center justify-between gap-3">
                              <span className="truncate max-w-[200px] text-slate-700">{o.title || o.orderId}</span>
                              {!multi && <span className="tabular-nums text-xs text-slate-400 shrink-0">{clp(o.amount)}</span>}
                            </div>
                          ))}
                        </div>
                        {multi && (
                          <div className="text-[10px] text-slate-400 mt-1">{l.orders.length} órdenes en este pago</div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {l.orders.length === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : l.docsOk === l.orders.length ? (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-700 w-fit">
                            ✓ {l.docsOk}/{l.orders.length}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700 w-fit">
                            {l.docsOk}/{l.orders.length} · falta
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium w-fit ${
                          l.liberado ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                        }`}>
                          {l.liberado ? "Liberado" : "Pendiente"}
                          {l.latestRelease ? ` ${format(new Date(l.latestRelease), "dd/MM", { locale: es })}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-400">
                        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={l.key + ":detail"} className="border-b bg-slate-50">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="grid grid-cols-3 gap-4 mb-3 text-xs">
                            <div><span className="text-slate-400">Bruto: </span><span className="tabular-nums">{clp(l.gross)}</span></div>
                            <div><span className="text-slate-400">Comisión MP: </span><span className="tabular-nums">{clp(l.fees)}</span></div>
                            <div><span className="text-slate-400">Neto recibido: </span><span className="tabular-nums font-medium">{clp(l.net)}</span></div>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-slate-400 border-b">
                                <th className="py-1 font-medium">Orden</th>
                                <th className="py-1 font-medium text-right">Venta</th>
                                <th className="py-1 font-medium">Documento</th>
                              </tr>
                            </thead>
                            <tbody>
                              {l.orders.map((o) => (
                                <tr key={o.id} className="border-b last:border-0">
                                  <td className="py-1 text-slate-700">{o.title || o.orderId} <span className="font-mono text-slate-400">({o.orderId})</span></td>
                                  <td className="py-1 text-right tabular-nums">{clp(o.amount)}</td>
                                  <td className="py-1">
                                    {o.hasDoc
                                      ? <span className="text-green-600">✓ Con documento</span>
                                      : <span className="text-red-600">Sin documento</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && liquidaciones.length > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-slate-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, liquidaciones.length)} de {liquidaciones.length}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-3">
          Cada fila es un pago real aprobado por MercadoPago, con la(s) venta(s) que cubre. El monto es el neto
          que efectivamente te depositaron (ya descontada la comisión) — no una estimación.
        </p>

        {/* Auditoría: esta es la única vista que le pregunta directo a MercadoPago
            "qué te pagaron", en vez de preguntarle a nuestras propias órdenes "¿te
            pagaron?". Sirve para encontrar pagos que el resto del pipeline nunca
            llegó a vincular a una venta — por eso vive aparte, no en la tabla
            principal (que solo puede mostrar lo que ya conocemos). */}
        <div className="mt-8 border-t pt-4">
          <button onClick={() => setAuditOpen((v) => !v)}
            className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800">
            <ShieldCheck className="h-4 w-4" />
            Auditar contra MercadoPago directamente
            {auditOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {auditOpen && (
            <div className="mt-3">
              <p className="text-xs text-slate-400 mb-3">
                Consulta <code>/v1/payments/search</code> directo en MercadoPago para este período — independiente
                de nuestras órdenes. Sirve para detectar pagos que MercadoPago aprobó y que esta tabla nunca
                llegó a ver, porque ninguna orden nuestra los referenció.
              </p>
              <button onClick={runAudit} disabled={auditLoading}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white text-sm font-medium rounded-lg mb-3">
                {auditLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verificar
              </button>
              {auditError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{auditError}</div>
              )}
              {auditResult && (
                <div className="bg-white border rounded-lg p-4">
                  <p className="text-sm mb-2">
                    MercadoPago aprobó <b>{auditResult.totalChecked}</b> pagos este período.{" "}
                    {auditResult.unmatchedCount === 0 ? (
                      <span className="text-green-700">✓ Todos están reflejados arriba.</span>
                    ) : (
                      <span className="text-red-700">
                        <b>{auditResult.unmatchedCount}</b> ({clp(auditResult.unmatchedAmount)}) no están en la tabla de
                        liquidaciones — ninguna orden nuestra los referenció.
                      </span>
                    )}
                  </p>
                  {auditResult.unmatched.length > 0 && (
                    <table className="w-full text-xs mt-2">
                      <thead>
                        <tr className="text-left text-slate-400 border-b">
                          <th className="py-1 font-medium">Payment ID</th>
                          <th className="py-1 font-medium text-right">Monto</th>
                          <th className="py-1 font-medium">Fecha</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditResult.unmatched.map((p) => (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="py-1 font-mono text-slate-500">{p.id}</td>
                            <td className="py-1 text-right tabular-nums">{clp(p.amount)}</td>
                            <td className="py-1 text-slate-500">{p.date_approved?.slice(0, 10)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
