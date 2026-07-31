import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Legend, Tooltip,
} from "recharts";
import { Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { clp } from "@/lib/tesoreria";

interface Props {
  period: string;
}

interface Rubro {
  rubro: string;
  raw_name: string;
  monto: number;
  tx_count: number;
}

interface Totals {
  gross: number;
  net: number;
  fees: number;
  tx_count: number;
}

const COLORS = ["#0ea5e9", "#14b8a6", "#f59e0b", "#a855f7", "#ef4444", "#64748b", "#22c55e", "#e11d48"];

export function TesoreriaCargos({ period }: Props) {
  const [loading, setLoading] = useState(true);
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: summary, error: summaryError }, { data: totalsResult, error: totalsError }] =
        await Promise.all([
          supabase.rpc("get_meli_billing_summary", { p_period: period }),
          supabase.rpc("get_meli_billing_totals", { p_period: period }),
        ]);

      if (summaryError) throw summaryError;
      if (totalsError) throw totalsError;

      setRubros(((summary || []) as Array<Record<string, unknown>>).map((row) => ({
        rubro: String(row.rubro || ""),
        raw_name: String(row.raw_name || ""),
        monto: Number(row.monto || 0),
        tx_count: Number(row.tx_count || 0),
      })));

      const total = (totalsResult as Array<Record<string, unknown>> | null)?.[0];
      setTotals(total ? {
        gross: Number(total.gross || 0),
        net: Number(total.net || 0),
        fees: Number(total.fees || 0),
        tx_count: Number(total.tx_count || 0),
      } : { gross: 0, net: 0, fees: 0, tx_count: 0 });
    } catch (error) {
      console.error("Error cargando cargos de Mercado Pago:", error);
      setRubros([]);
      setTotals({ gross: 0, net: 0, fees: 0, tx_count: 0 });
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const cargos = useMemo(() => rubros.filter((row) => row.monto >= 0), [rubros]);
  const reembolsos = useMemo(() => rubros.filter((row) => row.monto < 0), [rubros]);
  const totalCargos = useMemo(() => cargos.reduce((sum, row) => sum + row.monto, 0), [cargos]);
  const totalReembolsos = useMemo(
    () => reembolsos.reduce((sum, row) => sum + row.monto, 0),
    [reembolsos],
  );
  const totalDescontado = totalCargos + totalReembolsos;
  const pieData = useMemo(
    () => cargos.map((row) => ({ name: row.rubro, value: Math.round(row.monto) })),
    [cargos],
  );
  const pct = (amount: number) =>
    totals && totals.gross > 0 ? `${((amount / totals.gross) * 100).toFixed(2)}%` : "—";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400 text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Cargando cargos…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Cargos y comisiones de Mercado Pago</h2>
          <p className="text-xs text-slate-400 mt-1">
            Explica la diferencia entre el bruto vendido y el neto aprobado.
          </p>
        </div>
        <button
          onClick={fetchData}
          title="Actualizar cargos"
          className="p-1.5 hover:bg-slate-100 rounded text-slate-400"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Metric label="Ventas brutas" value={clp(totals?.gross || 0)} hint={`${totals?.tx_count || 0} pagos MP`} />
        <Metric
          label="Total descontado"
          value={clp(totalDescontado)}
          hint={`${pct(totalDescontado)} del bruto`}
          tone="red"
        />
        <Metric label="Cargos brutos" value={clp(totalCargos)} hint={`${pct(totalCargos)} del bruto`} />
        <Metric
          label="Reembolsos y cupones a favor"
          value={clp(totalReembolsos)}
          hint={`${reembolsos.length} rubros`}
          tone="green"
        />
      </div>

      {rubros.length === 0 ? (
        <div className="bg-white border rounded-lg p-8 text-center text-slate-400 text-sm">
          No hay cargos detallados para este período. Sincroniza los pagos de Mercado Pago.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b bg-slate-50">
              <p className="text-sm font-semibold text-slate-700">Desglose por rubro</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase text-slate-400 border-b">
                  <th className="text-left px-4 py-2">Rubro</th>
                  <th className="text-right px-4 py-2">Transacciones</th>
                  <th className="text-right px-4 py-2">Monto</th>
                  <th className="text-right px-4 py-2">% bruto</th>
                </tr>
              </thead>
              <tbody>
                {rubros.map((row) => (
                  <tr key={row.raw_name} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-800">{row.rubro}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{row.raw_name}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{row.tx_count}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-medium ${row.monto < 0 ? "text-emerald-600" : "text-slate-900"}`}>
                      {clp(row.monto)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{pct(row.monto)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-semibold">
                  <td className="px-4 py-2">Total descontado</td>
                  <td />
                  <td className={`px-4 py-2 text-right tabular-nums ${totalDescontado < 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {clp(totalDescontado)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{pct(totalDescontado)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="lg:col-span-2 bg-white border rounded-lg p-4">
            <p className="text-sm font-semibold text-slate-700 mb-2">Composición de descuentos</p>
            <div className="h-72">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}>
                    {pieData.map((_, index) => (
                      <Cell key={index} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => clp(value)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        Fuente: <span className="font-mono">Mercado Pago · charges_details</span> ·
        agrupado por fecha de aprobación del pago.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = "slate",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "slate" | "red" | "green";
}) {
  const valueClass = tone === "red"
    ? "text-rose-600"
    : tone === "green"
      ? "text-emerald-600"
      : "text-slate-900";

  return (
    <div className="bg-white border rounded-lg p-4">
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`text-xl font-bold mt-1 ${valueClass}`}>{value}</p>
      <p className="text-[11px] text-slate-400 mt-1">{hint}</p>
    </div>
  );
}
