import { useState } from "react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, TrendingDown, AlertCircle, Loader2 } from "lucide-react";
import { Nav } from "@/components/Nav";
import { usePeriodReconciliation } from "@/hooks/usePeriodReconciliation";

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

interface WaterfallRowProps {
  label: string;
  amount: number;
  total: number;
  variant: "income" | "expense" | "result" | "neutral";
  indent?: boolean;
  annotation?: string;
}

function WaterfallRow({ label, amount, total, variant, indent, annotation }: WaterfallRowProps) {
  const pct = total > 0 ? Math.abs(amount) / total : 0;
  const barW = Math.max(2, Math.round(pct * 100));

  const colors = {
    income:  { bar: "bg-emerald-400", text: "text-emerald-700", bg: "" },
    expense: { bar: "bg-red-300",     text: "text-red-600",     bg: "" },
    result:  { bar: "bg-slate-700",   text: "text-slate-900",   bg: "bg-slate-50" },
    neutral: { bar: "bg-slate-200",   text: "text-slate-500",   bg: "" },
  }[variant];

  return (
    <div className={`flex items-center gap-3 py-2 px-4 rounded-md ${colors.bg}`}>
      <div className={`text-sm flex-1 min-w-0 ${indent ? "pl-5" : ""} ${variant === "result" ? "font-semibold" : ""}`}>
        <span className="text-slate-700">{label}</span>
        {annotation && (
          <span className="ml-2 text-[11px] text-slate-400">{annotation}</span>
        )}
      </div>
      <div className="w-40 hidden sm:flex items-center gap-1.5">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${colors.bar}`}
            style={{ width: `${barW}%` }}
          />
        </div>
        <span className="text-[11px] text-slate-400 w-8 text-right">{PCT(Math.abs(amount), total)}</span>
      </div>
      <div className={`text-sm tabular-nums font-medium w-28 text-right ${colors.text}`}>
        {variant === "expense" ? `−${CLP(Math.abs(amount))}` : CLP(amount)}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-dashed border-slate-200 my-1 mx-4" />;
}

export default function PageFlujo() {
  const [periodo, setPeriodo] = useState(currentPeriod);
  const [canalId] = useState("todos");

  const { data, loading, error } = usePeriodReconciliation(canalId, periodo);

  const isCurrentMonth = periodo === currentPeriod();

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />

      <main className="flex-1 p-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <TrendingDown className="h-5 w-5 text-slate-400" />
            <h1 className="text-xl font-semibold text-slate-900">Flujo de ingresos</h1>
          </div>

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

        {loading && (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Cargando...
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm py-6 px-4 bg-red-50 rounded-lg">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            {/* Canal pills if multiple */}
            {data.ingresos.porCanal.length > 1 && (
              <div className="flex gap-2 px-4 pt-4 pb-0 flex-wrap">
                {data.ingresos.porCanal.map(c => (
                  <span key={c.canalId} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                    {c.nombre}: {CLP(c.monto)}
                  </span>
                ))}
              </div>
            )}

            {/* Data accuracy banner: real (MercadoPago) vs approximate */}
            {data.datosExactos.total > 0 && data.datosExactos.pct < 100 && (
              <div className="mx-4 mt-4 flex items-start gap-2 text-xs bg-amber-50 text-amber-700 rounded-lg px-3 py-2">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {data.datosExactos.ordenes}/{data.datosExactos.total} órdenes con montos exactos de MercadoPago ({data.datosExactos.pct}%).
                  Las {data.datosExactos.total - data.datosExactos.ordenes} restantes usan comisión aproximada hasta sincronizar pagos.
                </span>
              </div>
            )}
            {data.datosExactos.total > 0 && data.datosExactos.pct === 100 && (
              <div className="mx-4 mt-4 flex items-center gap-2 text-xs bg-emerald-50 text-emerald-700 rounded-lg px-3 py-2">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>Todos los montos provienen de datos reales de MercadoPago.</span>
              </div>
            )}

            <div className="py-3 space-y-0.5">
              {/* INGRESOS */}
              <div className="px-4 pt-1 pb-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Ingresos</p>
              </div>

              <WaterfallRow
                label="Ventas brutas"
                amount={data.ingresos.ventasBrutas}
                total={data.ingresos.ventasBrutas}
                variant="income"
                annotation={`${data.ingresos.porCanal.reduce((s, c) => s + c.ordenes, 0)} órdenes`}
              />

              <Divider />

              {/* EGRESOS */}
              <div className="px-4 pt-2 pb-1">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Egresos</p>
              </div>

              <WaterfallRow
                label="Comisión marketplace"
                amount={data.egresos.comisionMarketplace.monto}
                total={data.ingresos.ventasBrutas}
                variant="expense"
                indent
                annotation={
                  data.egresos.comisionMarketplace.conFactura.faltan > 0
                    ? `${data.egresos.comisionMarketplace.conFactura.faltan} sin factura`
                    : undefined
                }
              />

              <WaterfallRow
                label="Costos de envío"
                amount={data.egresos.costosEnvio.monto}
                total={data.ingresos.ventasBrutas}
                variant="expense"
                indent
              />

              <WaterfallRow
                label="Comisión de pago / financiamiento"
                amount={data.egresos.comisionPago.monto}
                total={data.ingresos.ventasBrutas}
                variant="expense"
                indent
              />

              <WaterfallRow
                label="Reembolsos / devoluciones"
                amount={data.egresos.reembolsos.monto}
                total={data.ingresos.ventasBrutas}
                variant="expense"
                indent
                annotation={
                  data.egresos.reembolsos.conNotaCredito.total > 0
                    ? `${data.egresos.reembolsos.conNotaCredito.con}/${data.egresos.reembolsos.conNotaCredito.total} con NC`
                    : undefined
                }
              />

              <Divider />

              {/* RESULTADO */}
              <WaterfallRow
                label="Líquido estimado a recibir"
                amount={data.liquidoRecibido}
                total={data.ingresos.ventasBrutas}
                variant="result"
              />

              <Divider />

              {/* BANCO */}
              <div className="px-4 pt-2 pb-1">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Abonos en banco</p>
              </div>

              <WaterfallRow
                label="Total abonos recibidos"
                amount={data.abonosBanco}
                total={data.ingresos.ventasBrutas}
                variant={data.abonosBanco > 0 ? "income" : "neutral"}
                annotation={data.abonosBanco === 0 ? "sin movimientos registrados" : undefined}
              />

              <Divider />

              {/* DIFERENCIA */}
              <div className="px-4 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">Diferencia (objetivo: $0)</span>
                  <span className={`text-sm font-bold tabular-nums ${
                    Math.abs(data.diferencia) < 100 ? "text-emerald-600" : "text-amber-600"
                  }`}>
                    {data.diferencia >= 0 ? "+" : ""}{CLP(data.diferencia)}
                  </span>
                </div>
              </div>
            </div>

            {/* DTE coverage footer */}
            <div className="border-t bg-slate-50 px-4 py-3 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                Cobertura DTE (ventas con boleta/factura)
              </span>
              <div className="flex items-center gap-3">
                <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${data.ingresos.conDte.pct >= 90 ? "bg-emerald-400" : "bg-amber-400"}`}
                    style={{ width: `${data.ingresos.conDte.pct}%` }}
                  />
                </div>
                <span className={`text-xs font-medium ${data.ingresos.conDte.pct >= 90 ? "text-emerald-600" : "text-amber-600"}`}>
                  {data.ingresos.conDte.pct}%
                  {data.ingresos.conDte.faltan > 0 && ` · ${data.ingresos.conDte.faltan} sin doc`}
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
