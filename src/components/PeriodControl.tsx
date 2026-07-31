import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useMeliPeriodControl } from "@/hooks/useMeliPeriodControl";
import { clp } from "@/lib/tesoreria";

interface Props {
  period: string;
}

const coverage = (part: number, total: number) =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : "—";

export function PeriodControl({ period }: Props) {
  const { data, loading, error } = useMeliPeriodControl(period);

  if (loading) {
    return (
      <div className="bg-white border rounded-lg p-4 mb-5 flex items-center text-xs text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Comparando Ventas, Documentos y Tesorería…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white border border-amber-200 rounded-lg p-4 mb-5 text-xs text-amber-700">
        No se pudo construir el control entre módulos{error ? `: ${error}` : "."}
      </div>
    );
  }

  const docOk = Math.abs(data.documentDelta) <= 1;
  const hasExceptions = data.withoutDocumentCount > 0 || data.withoutPaymentCount > 0 || !docOk;

  return (
    <section className="bg-white border rounded-xl p-4 mb-5 shadow-card">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Control de cifras entre módulos</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Base común: ventas reales de Mercado Libre creadas en {period}. No mezcla fecha de venta, fecha del DTE y fecha del pago.
          </p>
        </div>
        <div className={`flex items-center gap-1.5 text-xs font-medium ${hasExceptions ? "text-amber-600" : "text-emerald-600"}`}>
          {hasExceptions ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {hasExceptions ? "Hay diferencias explicables" : "Sin diferencias detectadas"}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ModuleBlock
          title="Ventas · Mercado Libre"
          main={clp(data.salesGross)}
          lines={[
            `${data.salesCount} ventas reales`,
            `${data.paidCount} con pago identificado · ${clp(data.paidSalesGross)} bruto`,
            `${data.withoutPaymentCount} sin pago · ${clp(data.withoutPaymentGross)}`,
          ]}
        />
        <ModuleBlock
          title="Documentos · Bsale"
          main={clp(data.documentedSalesGross)}
          mainHint={`${coverage(data.documentedCount, data.salesCount)} de las ventas documentado`}
          lines={[
            `${data.documentedCount} ventas con DTE`,
            `Monto DTE asignado: ${clp(data.documentAllocated)}`,
            docOk ? "DTE asignado cuadra con ventas documentadas" : `Diferencia DTE: ${clp(data.documentDelta)}`,
            `${data.withoutDocumentCount} sin DTE · ${clp(data.withoutDocumentGross)}`,
          ]}
          warning={!docOk || data.withoutDocumentCount > 0}
        />
        <ModuleBlock
          title="Tesorería · Mercado Pago"
          main={clp(data.netAfterAdjustments)}
          mainHint="neto después de devoluciones"
          lines={[
            `Neto aprobado: ${clp(data.approvedNet)}`,
            `Bruto pagado − neto: ${clp(data.deductionsAndAdjustments)}`,
            `Devoluciones: −${clp(data.refunds)}`,
            `Liberado: ${clp(data.releasedNet)} · pendiente ${clp(data.pendingReleaseNet)}`,
          ]}
          warning={data.withoutPaymentCount > 0}
        />
      </div>

      <p className="text-[10px] text-slate-400 mt-3">
        “Bruto pagado − neto” reúne todos los descuentos y ajustes informados por Mercado Pago; el detalle está en Cargos y comisiones.
      </p>
    </section>
  );
}

function ModuleBlock({
  title,
  main,
  mainHint,
  lines,
  warning = false,
}: {
  title: string;
  main: string;
  mainHint?: string;
  lines: string[];
  warning?: boolean;
}) {
  return (
    <div className={`border rounded-lg p-3.5 ${warning ? "border-amber-200 bg-amber-50/30" : "border-slate-200"}`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{title}</p>
      <p className="text-xl font-bold text-slate-900 mt-1 tabular-nums">{main}</p>
      {mainHint && <p className="text-[10px] text-slate-400 mb-2">{mainHint}</p>}
      <div className={`${mainHint ? "" : "mt-2"} space-y-1`}>
        {lines.map((line) => (
          <p key={line} className="text-[11px] text-slate-500 tabular-nums">{line}</p>
        ))}
      </div>
    </div>
  );
}
