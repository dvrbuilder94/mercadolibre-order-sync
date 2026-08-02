import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Legend, Tooltip,
} from "recharts";
import { Nav } from "@/components/Nav";
import { supabase } from "@/integrations/supabase/client";
import { chilePeriodNow } from "@/lib/chileDate";
import { clp } from "@/lib/tesoreria";

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

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

export default function PageBilling() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [loading, setLoading] = useState(true);
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: summary, error: e1 }, { data: totalsRes, error: e2 }] = await Promise.all([
        supabase.rpc("get_meli_billing_summary", { p_period: period }),
        supabase.rpc("get_meli_billing_totals", { p_period: period }),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      setRubros(((summary || []) as any[]).map((r) => ({
        rubro: r.rubro,
        raw_name: r.raw_name,
        monto: Number(r.monto || 0),
        tx_count: Number(r.tx_count || 0),
      })));
      const t = (totalsRes as any[])?.[0];
      setTotals(t ? {
        gross: Number(t.gross || 0),
        net: Number(t.net || 0),
        fees: Number(t.fees || 0),
        tx_count: Number(t.tx_count || 0),
      } : { gross: 0, net: 0, fees: 0, tx_count: 0 });
    } catch (e) {
      console.error("Error cargando billing:", e);
      setRubros([]);
      setTotals({ gross: 0, net: 0, fees: 0, tx_count: 0 });
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  // Cargos (montos > 0) y reembolsos/cupones a favor (montos < 0)
  const cargos = useMemo(() => rubros.filter((r) => r.monto >= 0), [rubros]);
  const reembolsos = useMemo(() => rubros.filter((r) => r.monto < 0), [rubros]);
  const totalCargos = useMemo(() => cargos.reduce((s, r) => s + r.monto, 0), [cargos]);
  const totalReembolsos = useMemo(() => reembolsos.reduce((s, r) => s + r.monto, 0), [reembolsos]);
  const netoFacturado = totalCargos + totalReembolsos;

  const pieData = useMemo(
    () => cargos.map((r) => ({ name: r.rubro, value: Math.round(r.monto) })),
    [cargos],
  );

  const pct = (n: number) => (totals && totals.gross > 0 ? ((n / totals.gross) * 100).toFixed(2) + "%" : "—");

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-6xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Cargos y comisiones MercadoLibre</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Por qué el bruto de tus ventas termina en el neto disponible en Mercado Pago: comisiones, envíos, cupones y otros ajustes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => changePeriod(-1)} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium capitalize w-36 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              onClick={fetchData}
              disabled={loading}
              className="p-1.5 hover:bg-slate-100 rounded text-slate-400 disabled:opacity-40 ml-1"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Cargando facturación…
          </div>
        ) : (
          <>
            {/* KPIs superiores */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
              <div className="bg-white border rounded-lg p-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Ventas brutas</p>
                <p className="text-xl font-bold text-slate-900 mt-1">{clp(totals?.gross || 0)}</p>
                <p className="text-[11px] text-slate-400 mt-1">{totals?.tx_count || 0} pagos MP</p>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Total descontado por MELI</p>
                <p className="text-xl font-bold text-rose-600 mt-1">{clp(netoFacturado)}</p>
                <p className="text-[11px] text-slate-400 mt-1">{pct(netoFacturado)} del bruto</p>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Cargos brutos</p>
                <p className="text-xl font-bold text-slate-900 mt-1">{clp(totalCargos)}</p>
                <p className="text-[11px] text-slate-400 mt-1">{pct(totalCargos)} del bruto</p>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Reembolsos / cupones a favor</p>
                <p className="text-xl font-bold text-emerald-600 mt-1">{clp(totalReembolsos)}</p>
                <p className="text-[11px] text-slate-400 mt-1">{reembolsos.length} rubros</p>
              </div>
            </div>

            {rubros.length === 0 ? (
              <div className="bg-white border rounded-lg p-8 text-center text-slate-400 text-sm">
                No hay datos de cargos para {periodLabel(period)}. Sincroniza los detalles de pago de MELI
                desde Sync avanzada para poblar este período.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                {/* Tabla */}
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
                        <th className="text-right px-4 py-2">% s/ bruto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rubros.map((r) => (
                        <tr key={r.raw_name} className="border-b last:border-0">
                          <td className="px-4 py-2">
                            <div className="font-medium text-slate-800">{r.rubro}</div>
                            <div className="text-[10px] text-slate-400 font-mono">{r.raw_name}</div>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.tx_count}</td>
                          <td className={`px-4 py-2 text-right tabular-nums font-medium ${r.monto < 0 ? "text-emerald-600" : "text-slate-900"}`}>
                            {clp(r.monto)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-500">{pct(r.monto)}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 font-semibold">
                        <td className="px-4 py-2">Total descontado</td>
                        <td></td>
                        <td className={`px-4 py-2 text-right tabular-nums ${netoFacturado < 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {clp(netoFacturado)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-500">{pct(netoFacturado)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Pie */}
                <div className="lg:col-span-2 bg-white border rounded-lg p-4">
                  <p className="text-sm font-semibold text-slate-700 mb-2">Composición de descuentos</p>
                  <div className="h-72">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}>
                          {pieData.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v: number) => clp(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-400 mt-6">
              Fuente: <span className="font-mono">meli_payment_details.raw_data.charges_details</span> ·
              Agrupado por fecha de aprobación del pago (date_approved).
            </p>
          </>
        )}
      </main>
    </div>
  );
}
