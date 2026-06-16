import { useState } from "react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, Home, AlertTriangle,
  CheckCircle2, XCircle, Loader2, AlertCircle,
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

// ── Mini waterfall card ───────────────────────────────────────────────────────
function WaterfallMini({ data }: { data: PeriodReconciliation }) {
  const { ventasBrutas } = data.ingresos;
  const { comisionMarketplace, costosEnvio, comisionPago, reembolsos } = data.egresos;

  const rows = [
    { label: "Ventas brutas",    amount: ventasBrutas,                color: "bg-emerald-400", sign: 1  },
    { label: "Comisión MeLi",    amount: comisionMarketplace.monto,   color: "bg-red-300",     sign: -1 },
    { label: "Envío",            amount: costosEnvio.monto,           color: "bg-red-200",     sign: -1 },
    { label: "Financiamiento",   amount: comisionPago.monto,          color: "bg-red-100",     sign: -1 },
    { label: "Devoluciones",     amount: reembolsos.monto,            color: "bg-red-200",     sign: -1 },
  ];

  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const pct = ventasBrutas > 0 ? Math.max(2, Math.round((r.amount / ventasBrutas) * 100)) : 2;
        return (
          <div key={r.label} className="flex items-center gap-2">
            <span className="text-xs text-slate-500 w-36 shrink-0">{r.label}</span>
            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${r.color}`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`text-xs tabular-nums font-medium w-24 text-right ${r.sign < 0 ? "text-red-500" : "text-emerald-600"}`}>
              {r.sign < 0 ? "−" : ""}{CLP(r.amount)}
            </span>
          </div>
        );
      })}

      <div className="border-t border-dashed border-slate-200 pt-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600">Líquido estimado</span>
        <span className="text-sm font-bold text-slate-900 tabular-nums">{CLP(data.liquidoRecibido)}</span>
      </div>
    </div>
  );
}

// ── Exception badge ───────────────────────────────────────────────────────────
function ExcepcionRow({ exc }: { exc: PeriodReconciliation['excepciones'][number] }) {
  const isDanger = exc.severidad === 'danger' && exc.count > 0;
  const isOk     = exc.count === 0;

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
      isOk     ? "bg-emerald-50"
      : isDanger ? "bg-red-50"
      : "bg-amber-50"
    }`}>
      {isOk
        ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        : isDanger
          ? <XCircle className="h-4 w-4 text-red-500 shrink-0" />
          : <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      }
      <span className={`flex-1 ${isOk ? "text-slate-500" : "text-slate-700"}`}>{exc.label}</span>
      {exc.count > 0 && (
        <span className={`font-bold ${isDanger ? "text-red-600" : "text-amber-600"}`}>{exc.count}</span>
      )}
    </div>
  );
}

// ── DTE progress bar ──────────────────────────────────────────────────────────
function DteBar({ pct, faltan }: { pct: number; faltan: number }) {
  const color = pct >= 95 ? "bg-emerald-400" : pct >= 80 ? "bg-amber-400" : "bg-red-400";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500">Cobertura DTE</span>
        <span className={`font-medium ${pct >= 95 ? "text-emerald-600" : pct >= 80 ? "text-amber-600" : "text-red-600"}`}>
          {pct}% {faltan > 0 ? `· ${faltan} sin doc` : "· completo"}
        </span>
      </div>
      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PageDashboard() {
  const [periodo, setPeriodo]     = useState(currentPeriod);
  const [canalId, setCanalId]     = useState("todos");
  const [closing, setClosing]     = useState(false);
  const { toast }                 = useToast();

  const { data, loading, error }  = usePeriodReconciliation(canalId, periodo);
  const isCurrentMonth            = periodo === currentPeriod();

  const handleClose = async () => {
    if (!data?.cierre.puedeCerrar) return;
    setClosing(true);
    try {
      const { error: closeErr } = await supabase
        .from('monthly_closings')
        .upsert(
          {
            period:                periodo,
            status:                'closed',
            closed_at:             new Date().toISOString(),
            total_sales_count:     data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0),
            total_sales_amount:    data.ingresos.ventasBrutas,
            pending_document_count: data.ingresos.conDte.faltan,
          },
          { onConflict: 'user_id,period' }
        );

      if (closeErr) throw closeErr;
      toast({ title: "Período cerrado", description: `${periodLabel(periodo)} marcado como cerrado.` });
    } catch (e: any) {
      toast({ title: "Error al cerrar", description: e?.message, variant: "destructive" });
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />

      <main className="flex-1 p-6">
        <div className="max-w-4xl mx-auto space-y-6">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Home className="h-5 w-5 text-slate-400" />
              <h1 className="text-xl font-semibold text-slate-900">Resumen del período</h1>
            </div>

            <div className="flex items-center gap-2">
              {/* Period nav */}
              <div className="flex items-center gap-1 bg-white border rounded-lg px-1 py-1">
                <button
                  onClick={() => setPeriodo(prevPeriod)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-800"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm font-medium text-slate-800 px-2 min-w-[130px] text-center capitalize">
                  {periodLabel(periodo)}
                </span>
                <button
                  onClick={() => setPeriodo(nextPeriod)}
                  disabled={isCurrentMonth}
                  className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-800 disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Canal selector (only when multiple channels exist) */}
          {data && data.canales.length > 2 && (
            <div className="flex gap-2 flex-wrap">
              {data.canales.map(c => (
                <button
                  key={c.id}
                  onClick={() => setCanalId(c.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    canalId === c.id
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                  }`}
                >
                  {c.nombre}
                  <span className="ml-1.5 opacity-60">{c.ordenes}</span>
                </button>
              ))}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Calculando...
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm py-6 px-4 bg-red-50 rounded-lg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* Left: KPI cards + waterfall */}
              <div className="lg:col-span-2 space-y-5">

                {/* KPI row */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white rounded-xl border shadow-sm p-4">
                    <p className="text-xs text-slate-400 mb-1">Ventas brutas</p>
                    <p className="text-xl font-bold text-slate-900 tabular-nums">{CLP(data.ingresos.ventasBrutas)}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0)} órdenes
                    </p>
                  </div>

                  <div className="bg-white rounded-xl border shadow-sm p-4">
                    <p className="text-xs text-slate-400 mb-1">Líquido estimado</p>
                    <p className="text-xl font-bold text-slate-900 tabular-nums">{CLP(data.liquidoRecibido)}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {data.ingresos.ventasBrutas > 0
                        ? `${Math.round((data.liquidoRecibido / data.ingresos.ventasBrutas) * 100)}% del bruto`
                        : "—"}
                    </p>
                  </div>

                  <div className="bg-white rounded-xl border shadow-sm p-4">
                    <p className="text-xs text-slate-400 mb-1">Diferencia vs banco</p>
                    <p className={`text-xl font-bold tabular-nums ${
                      Math.abs(data.diferencia) < 100 ? "text-emerald-600" : "text-amber-600"
                    }`}>
                      {data.diferencia >= 0 ? "+" : ""}{CLP(data.diferencia)}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      {data.abonosBanco === 0 ? "sin abonos banco" : `${CLP(data.abonosBanco)} banco`}
                    </p>
                  </div>
                </div>

                {/* Waterfall mini */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Desglose de ingresos</p>
                  <WaterfallMini data={data} />
                </div>

                {/* DTE coverage */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Documentación tributaria</p>
                  <DteBar pct={data.ingresos.conDte.pct} faltan={data.ingresos.conDte.faltan} />
                </div>
              </div>

              {/* Right: Excepciones + Cierre */}
              <div className="space-y-5">

                {/* Excepciones */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Excepciones</p>
                  <div className="space-y-2">
                    {data.excepciones.map(exc => (
                      <ExcepcionRow key={exc.tipo} exc={exc} />
                    ))}
                  </div>
                </div>

                {/* Cierre */}
                <div className="bg-white rounded-xl border shadow-sm p-5">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cierre de período</p>

                  {data.cierre.estado === 'cerrado' ? (
                    <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4" />
                      Período cerrado
                    </div>
                  ) : (
                    <>
                      {data.cierre.bloqueadores > 0 && (
                        <p className="text-xs text-red-500 mb-3">
                          {data.cierre.bloqueadores} bloqueador{data.cierre.bloqueadores > 1 ? "es" : ""} activo{data.cierre.bloqueadores > 1 ? "s" : ""}. Resuélvelos antes de cerrar.
                        </p>
                      )}

                      {data.cierre.bloqueadores === 0 && (
                        <p className="text-xs text-slate-500 mb-3">
                          Sin bloqueadores. Puedes cerrar el período cuando estés listo.
                        </p>
                      )}

                      <button
                        onClick={handleClose}
                        disabled={!data.cierre.puedeCerrar || closing}
                        className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                          data.cierre.puedeCerrar
                            ? "bg-slate-900 text-white hover:bg-slate-700"
                            : "bg-slate-100 text-slate-400 cursor-not-allowed"
                        }`}
                      >
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
          )}
        </div>
      </main>
    </div>
  );
}
