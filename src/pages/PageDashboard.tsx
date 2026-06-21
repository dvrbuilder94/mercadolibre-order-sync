import { useState } from "react";
import { Link } from "react-router-dom";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, Home, AlertTriangle, ArrowRight,
  CheckCircle2, XCircle, Loader2, AlertCircle, TrendingUp, Wallet, Scale,
} from "lucide-react";
import { Nav } from "@/components/Nav";
import { usePeriodReconciliation } from "@/hooks/usePeriodReconciliation";
import type { PeriodReconciliation } from "@/types/reconciliation";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/components/ui/use-toast";

const currentPeriod = () => format(new Date(), "yyyy-MM");
const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};
const prevPeriod = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(subMonths(new Date(y, m - 1, 1), 1), "yyyy-MM");
};
const nextPeriod = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m, 1), "yyyy-MM");
};

const CLP = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n || 0);
const PCT = (n: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;

// ── P&L waterfall row (same component used in /flujo, now unified here) ──────
interface WaterfallRowProps {
  label: string;
  amount: number;
  total: number;
  variant: "income" | "expense" | "result" | "neutral";
  indent?: boolean;
  annotation?: string;
  approx?: boolean;
}
function WaterfallRow({ label, amount, total, variant, indent, annotation, approx }: WaterfallRowProps) {
  const pct = total > 0 ? Math.abs(amount) / total : 0;
  const barW = Math.max(2, Math.round(pct * 100));
  const colors = {
    income:  { bar: "bg-emerald-400", text: "text-emerald-700" },
    expense: { bar: "bg-red-300",     text: "text-red-600"     },
    result:  { bar: "bg-slate-700",   text: "text-slate-900"   },
    neutral: { bar: "bg-slate-200",   text: "text-slate-500"   },
  }[variant];
  return (
    <div className={`flex items-center gap-3 py-1.5 ${variant === "result" ? "bg-slate-50 rounded-md px-2 -mx-2" : ""}`}>
      <div className={`text-sm flex-1 min-w-0 ${indent ? "pl-4" : ""} ${variant === "result" ? "font-semibold" : ""}`}>
        <span className="text-slate-700">{label}</span>
        {annotation && <span className="ml-2 text-[11px] text-slate-400">{annotation}</span>}
      </div>
      <div className="w-28 hidden sm:flex items-center gap-1.5">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${barW}%` }} />
        </div>
        <span className="text-[11px] text-slate-400 w-7 text-right">{PCT(Math.abs(amount), total)}</span>
      </div>
      <div
        className={`text-sm tabular-nums font-medium w-24 text-right ${colors.text}`}
        title={approx ? "Incluye órdenes con comisión estimada (sin sincronizar con MercadoPago)" : undefined}
      >
        {approx && "≈ "}{variant === "expense" ? `−${CLP(Math.abs(amount))}` : CLP(amount)}
      </div>
    </div>
  );
}

// ── Cola de revisión: misma data de excepciones, en lenguaje plano + acción ────
const EXCEPCION_CTA: Record<PeriodReconciliation['excepciones'][number]['tipo'], { sentence: (c: number) => string; ctaLabel: string; to: string }> = {
  venta_sin_dte:     { sentence: c => `${c} venta${c > 1 ? "s" : ""} sin boleta o factura emitida`,            ctaLabel: "Revisar en Conciliación", to: "/conciliacion" },
  pago_atascado:     { sentence: c => `${c} pago${c > 1 ? "s" : ""} sin confirmar — faltan datos de MercadoPago`, ctaLabel: "Sincronizar pagos",        to: "/pipeline" },
  devolucion_sin_nc: { sentence: c => `${c} devolución${c > 1 ? "es" : ""} sin nota de crédito asociada`,       ctaLabel: "Revisar en Conciliación", to: "/conciliacion" },
  score_bajo:        { sentence: c => `${c} coincidencia${c > 1 ? "s" : ""} de baja confianza entre orden y documento`, ctaLabel: "Revisar en Conciliación", to: "/conciliacion" },
};

function ExcepcionRow({ exc }: { exc: PeriodReconciliation['excepciones'][number] }) {
  const isOk = exc.count === 0;

  if (isOk) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-slate-400">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
        <span>{exc.label} — sin pendientes</span>
      </div>
    );
  }

  const isDanger = exc.severidad === 'danger';
  const cta = EXCEPCION_CTA[exc.tipo];
  return (
    <div className={`flex items-center gap-3 pl-3 pr-2 py-2.5 rounded-lg border-l-[3px] ${
      isDanger ? "bg-red-50 border-red-400" : "bg-amber-50 border-amber-400"
    }`}>
      {isDanger
        ? <XCircle className="h-4 w-4 text-red-500 shrink-0" />
        : <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      }
      <span className="flex-1 text-xs text-slate-700">{cta.sentence(exc.count)}</span>
      <Link
        to={cta.to}
        className={`flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap shrink-0 ${
          isDanger ? "text-red-600 hover:text-red-700" : "text-amber-700 hover:text-amber-800"
        }`}
      >
        {cta.ctaLabel}<ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PageDashboard() {
  const [periodo, setPeriodo]   = useState(currentPeriod);
  const [canalId, setCanalId]   = useState("todos");
  const [closing, setClosing]   = useState(false);
  const { toast }               = useToast();
  const { data, loading, error } = usePeriodReconciliation(canalId, periodo);
  const isCurrentMonth           = periodo === currentPeriod();

  const handleClose = async () => {
    if (!data?.cierre.puedeCerrar) return;
    setClosing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Sin sesión activa');
      const { error: closeErr } = await supabase
        .from('monthly_closings')
        .upsert({
          user_id:               user.id,
          period:                periodo,
          status:                'closed',
          closed_at:             new Date().toISOString(),
          total_sales_count:     data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0),
          total_sales_amount:    data.ingresos.ventasBrutas,
          pending_document_count: data.ingresos.conDte.faltan,
        }, { onConflict: 'user_id,period' });
      if (closeErr) throw closeErr;
      toast({ title: "Período cerrado", description: `${periodLabel(periodo)} marcado como cerrado.` });
    } catch (e: any) {
      toast({ title: "Error al cerrar", description: e?.message, variant: "destructive" });
    } finally { setClosing(false); }
  };

  const { ventasBrutas } = data?.ingresos ?? { ventasBrutas: 0 };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-6">
        <div className="max-w-5xl mx-auto space-y-5">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Home className="h-5 w-5 text-slate-400" />
              <h1 className="text-xl font-semibold text-slate-900">Resumen del período</h1>
              {data?.datosExactos && data.datosExactos.total > 0 && (
                <span
                  title="Órdenes con montos reales de MercadoPago. El resto usa valores aproximados."
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full ml-2 ${
                    data.datosExactos.pct >= 90 ? "bg-emerald-50 text-emerald-600"
                    : data.datosExactos.pct >= 50 ? "bg-amber-50 text-amber-600"
                    : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {data.datosExactos.pct}% datos reales
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 bg-white border rounded-lg px-1 py-1">
              <button onClick={() => setPeriodo(prevPeriod)} className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-800">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-slate-800 px-2 min-w-[130px] text-center capitalize">
                {periodLabel(periodo)}
              </span>
              <button onClick={() => setPeriodo(nextPeriod)} disabled={isCurrentMonth}
                className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-800 disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Canal pills */}
          {data && data.canales.length > 1 && (
            <div className="flex gap-2 flex-wrap">
              {data.canales.map(c => (
                <button key={c.id} onClick={() => setCanalId(c.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    canalId === c.id
                      ? "bg-primary text-white border-primary"
                      : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                  }`}>
                  {c.nombre}<span className="ml-1.5 opacity-60">{c.ordenes}</span>
                </button>
              ))}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />Calculando...
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm py-6 px-4 bg-red-50 rounded-lg">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white rounded-xl border shadow-card hover:shadow-elevated transition-shadow p-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-slate-400">Ventas brutas</p>
                    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                      <TrendingUp className="h-3.5 w-3.5" />
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums">{CLP(data.ingresos.ventasBrutas)}</p>
                  <p className="text-xs text-slate-400 mt-1">{data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0)} órdenes</p>
                </div>
                <div className="bg-white rounded-xl border shadow-card hover:shadow-elevated transition-shadow p-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-slate-400">Líquido a recibir</p>
                    <div className="h-7 w-7 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                      <Wallet className="h-3.5 w-3.5" />
                    </div>
                  </div>
                  <p
                    className="text-2xl font-bold text-slate-900 tabular-nums"
                    title={data.datosExactos.pct < 100 ? "Incluye órdenes con comisión estimada (sin sincronizar con MercadoPago)" : undefined}
                  >
                    {data.datosExactos.pct < 100 && <span className="text-slate-400 mr-1">≈</span>}{CLP(data.liquidoRecibido)}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    {ventasBrutas > 0 ? `${Math.round((data.liquidoRecibido / ventasBrutas) * 100)}% del bruto` : "—"}
                  </p>
                </div>
                <div className="bg-white rounded-xl border shadow-card hover:shadow-elevated transition-shadow p-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-slate-400">Diferencia vs banco</p>
                    <div className="h-7 w-7 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
                      <Scale className="h-3.5 w-3.5" />
                    </div>
                  </div>
                  {data.abonosBanco === 0 ? (
                    <>
                      <p className="text-2xl font-bold tabular-nums text-slate-300">—</p>
                      <p className="text-xs text-slate-400 mt-1">banco no conectado</p>
                    </>
                  ) : (
                    <>
                      <p className={`text-2xl font-bold tabular-nums ${Math.abs(data.diferencia) < 100 ? "text-emerald-600" : "text-amber-600"}`}>
                        {data.diferencia >= 0 ? "+" : ""}{CLP(data.diferencia)}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">vs {CLP(data.abonosBanco)} banco</p>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-5">
                {/* Left: full P&L waterfall */}
                <div className="col-span-2 space-y-4">
                  <div className="bg-white rounded-xl border shadow-card p-5">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Estado de resultados</p>

                    {data.datosExactos.pct < 100 && data.datosExactos.total > 0 && (
                      <div className="flex items-start gap-2 text-xs bg-amber-50 text-amber-700 rounded-lg px-3 py-2 mb-4">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          {data.datosExactos.ordenes}/{data.datosExactos.total} órdenes con datos exactos de MercadoPago.
                          Las {data.datosExactos.total - data.datosExactos.ordenes} restantes usan comisión aproximada.
                          Sincroniza los pagos en Conciliación para cifras 100% reales.
                        </span>
                      </div>
                    )}

                    <div className="space-y-0.5">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Ingresos</p>
                      <WaterfallRow
                        label="Ventas brutas"
                        amount={data.ingresos.ventasBrutas}
                        total={data.ingresos.ventasBrutas}
                        variant="income"
                        annotation={`${data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0)} órdenes`}
                      />
                      {data.ingresos.porCanal.length > 1 && (
                        <div className="pl-4 pb-1">
                          {data.ingresos.porCanal.map(c => (
                            <div key={c.canalId} className="flex justify-between text-[11px] text-slate-400 py-0.5">
                              <span>{c.nombre}</span>
                              <span className="tabular-nums">{CLP(c.monto)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="border-t border-dashed border-slate-100 my-2" />
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Egresos</p>

                      <WaterfallRow label="Comisión marketplace" amount={data.egresos.comisionMarketplace.monto} total={ventasBrutas} variant="expense" indent
                        annotation={data.egresos.comisionMarketplace.conFactura.faltan > 0 ? `${data.egresos.comisionMarketplace.conFactura.faltan} sin factura` : undefined}
                        approx={data.datosExactos.pct < 100} />
                      <WaterfallRow label="Costos de envío" amount={data.egresos.costosEnvio.monto} total={ventasBrutas} variant="expense" indent />
                      <WaterfallRow label="Comisión de pago" amount={data.egresos.comisionPago.monto} total={ventasBrutas} variant="expense" indent
                        annotation={data.egresos.comisionPago.monto === 0 ? "pendiente sincronización" : undefined} />
                      <WaterfallRow label="Devoluciones"
                        amount={data.egresos.reembolsos.monto} total={ventasBrutas} variant="expense" indent
                        annotation={data.egresos.reembolsos.conNotaCredito.total > 0
                          ? `${data.egresos.reembolsos.conNotaCredito.con}/${data.egresos.reembolsos.conNotaCredito.total} con NC`
                          : undefined} />

                      <div className="border-t border-dashed border-slate-100 my-2" />
                      <WaterfallRow label="Líquido a recibir" amount={data.liquidoRecibido} total={ventasBrutas} variant="result"
                        approx={data.datosExactos.pct < 100} />

                      <div className="border-t border-dashed border-slate-100 my-2" />
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Banco</p>
                      {data.abonosBanco === 0 ? (
                        <p className="text-xs text-slate-300 italic py-1.5">
                          Sin movimientos de banco — conéctalo en Configuración para ver la diferencia real.
                        </p>
                      ) : (
                        <>
                          <WaterfallRow label="Abonos recibidos" amount={data.abonosBanco} total={ventasBrutas} variant="income" />
                          <div className="border-t border-dashed border-slate-100 my-2" />
                          <div className="flex items-center justify-between py-1">
                            <span className="text-sm font-semibold text-slate-700">Diferencia (objetivo: $0)</span>
                            <span className={`text-sm font-bold tabular-nums ${Math.abs(data.diferencia) < 100 ? "text-emerald-600" : "text-amber-600"}`}>
                              {data.diferencia >= 0 ? "+" : ""}{CLP(data.diferencia)}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* DTE coverage */}
                  <div className="bg-white rounded-xl border shadow-card p-4">
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-slate-500 font-medium">Cobertura DTE (boleta/factura)</span>
                      <span className={`font-semibold ${data.ingresos.conDte.pct >= 95 ? "text-emerald-600" : data.ingresos.conDte.pct >= 80 ? "text-amber-600" : "text-red-600"}`}>
                        {data.ingresos.conDte.pct}%
                        {data.ingresos.conDte.faltan > 0 ? ` · ${data.ingresos.conDte.faltan} sin doc` : " · completo"}
                      </span>
                    </div>
                    <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${data.ingresos.conDte.pct >= 95 ? "bg-emerald-400" : data.ingresos.conDte.pct >= 80 ? "bg-amber-400" : "bg-red-400"}`}
                        style={{ width: `${data.ingresos.conDte.pct}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Right: exceptions + cierre */}
                <div className="space-y-4">
                  <div className="bg-white rounded-xl border shadow-card p-4">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cola de revisión</p>
                    <div className="space-y-2">
                      {data.excepciones.map(exc => <ExcepcionRow key={exc.tipo} exc={exc} />)}
                    </div>
                  </div>

                  <div className="bg-white rounded-xl border shadow-card p-4">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cierre de período</p>
                    {data.cierre.estado === 'cerrado' ? (
                      <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium">
                        <CheckCircle2 className="h-4 w-4" />Período cerrado
                      </div>
                    ) : (
                      <>
                        <p className="text-xs text-slate-500 mb-3">
                          {data.cierre.bloqueadores > 0
                            ? `${data.cierre.bloqueadores} bloqueador${data.cierre.bloqueadores > 1 ? "es" : ""} activo${data.cierre.bloqueadores > 1 ? "s" : ""}. Resuélvelos antes de cerrar.`
                            : "Sin bloqueadores. Puedes cerrar el período."
                          }
                        </p>
                        <button onClick={handleClose} disabled={!data.cierre.puedeCerrar || closing}
                          className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                            data.cierre.puedeCerrar
                              ? "bg-primary text-white hover:bg-primary/90"
                              : "bg-slate-100 text-slate-400 cursor-not-allowed"
                          }`}>
                          {closing
                            ? <span className="flex items-center justify-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Cerrando...</span>
                            : "Cerrar período"
                          }
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
