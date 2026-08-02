import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { clp } from "@/lib/tesoreria";
import type { MonthlyControlSnapshot } from "@/lib/monthlyControl";

interface Props {
  snapshot: MonthlyControlSnapshot;
}

export function MonthlyControlPanel({ snapshot }: Props) {
  const fiscalDelta = snapshot.bridges.fiscal_vs_commercial_after_reversals;
  const cashDelta = snapshot.bridges.cash_gross_vs_fiscal;
  const balanced = fiscalDelta === 0 && cashDelta === 0;

  return (
    <section className="bg-white border rounded-xl p-4 mb-5" aria-label="Control mensual canónico">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Control del mes</p>
          <p className="text-[11px] text-slate-400">Tres fechas: venta, emisión fiscal y movimiento de caja · horario Chile</p>
        </div>
        <div className={`flex items-center gap-1 text-xs font-medium ${balanced ? "text-emerald-600" : "text-amber-600"}`}>
          {balanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {balanced ? "Cuadra" : "Revisar diferencias"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Axis label="Comercial" value={snapshot.commercial.gross_sales} sub={`${snapshot.commercial.order_count} ventas`} />
        <Axis label="Fiscal neto de NC" value={snapshot.fiscal.gross_documents} sub={`${snapshot.fiscal.document_count} DTE emitidos`} />
        <Axis label="Caja bruta neta de reversas" value={snapshot.cash.gross_movements} sub={`${snapshot.cash.movement_count} movimientos reales`} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-[11px] text-slate-500">
        <span>Venta − NC → fiscal: <strong className={fiscalDelta === 0 ? "text-emerald-600" : "text-amber-600"}>{clp(fiscalDelta)}</strong></span>
        <span>Caja bruta → fiscal: <strong className={cashDelta === 0 ? "text-emerald-600" : "text-amber-600"}>{clp(cashDelta)}</strong></span>
        <span>Sin DTE: <strong>{snapshot.commercial.without_valid_dte_order_count}</strong></span>
        <span>Pagos sin venta: <strong>{snapshot.cash.unmatched_movement_count}</strong></span>
      </div>
    </section>
  );
}

function Axis({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-lg font-bold text-slate-800 mt-0.5">{clp(value)}</p>
      <p className="text-[11px] text-slate-400">{sub}</p>
    </div>
  );
}
