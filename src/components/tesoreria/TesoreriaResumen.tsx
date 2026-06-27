import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { Loader2, AlertCircle, CheckCircle2, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { clp, TesoreriaPayment, channelLabel } from "@/lib/tesoreria";

interface Props {
  payments: TesoreriaPayment[];
  upcomingReleases: { date: string; net: number; count: number }[];
  period: string;
  rangeIso: { from: string; to: string };
  onJumpToDetail: (filter: "orphan" | "partial") => void;
}

const PIE_COLORS = ["#0ea5e9", "#14b8a6", "#f59e0b", "#a855f7", "#ef4444", "#64748b"];

export function TesoreriaResumen({ payments, upcomingReleases, rangeIso, onJumpToDetail }: Props) {
  const kpis = useMemo(() => {
    let received = 0, releasedNet = 0, pendingNet = 0, matched = 0, orphanCount = 0, orphanAmount = 0;
    for (const p of payments) {
      received += p.net;
      if (p.liberado) releasedNet += p.net; else pendingNet += p.net;
      if (p.matchState === "matched") matched++;
      if (p.matchState === "orphan") { orphanCount++; orphanAmount += p.net; }
    }
    const matchedPct = payments.length > 0 ? Math.round((matched / payments.length) * 100) : 0;
    return { received, releasedNet, pendingNet, matchedPct, orphanCount, orphanAmount, count: payments.length };
  }, [payments]);

  const dailySeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of payments) {
      const d = p.paymentDate.slice(0, 10);
      map.set(d, (map.get(d) || 0) + p.net);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, net]) => ({ date: date.slice(5), net: Math.round(net) }));
  }, [payments]);

  const methodSeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of payments) {
      map.set(p.method, (map.get(p.method) || 0) + p.net);
    }
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [payments]);

  const channelSeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of payments) {
      if (p.channels.length === 0) {
        map.set("Sin canal", (map.get("Sin canal") || 0) + p.net);
        continue;
      }
      const share = p.net / p.channels.length;
      for (const ch of p.channels) {
        const label = channelLabel(ch);
        map.set(label, (map.get(label) || 0) + share);
      }
    }
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value);
  }, [payments]);

  const [orphanLoading, setOrphanLoading] = useState(false);
  const [orphanErr, setOrphanErr] = useState<string | null>(null);
  const [orphanRes, setOrphanRes] = useState<{ totalChecked: number; unmatchedCount: number; unmatchedAmount: number } | null>(null);

  const runOrphanScan = async () => {
    setOrphanLoading(true); setOrphanErr(null);
    try {
      const { data, error } = await supabase.functions.invoke("check-orphan-payments", {
        body: { date_from: rangeIso.from, date_to: rangeIso.to },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Error desconocido");
      setOrphanRes({
        totalChecked: data.totalChecked,
        unmatchedCount: data.unmatchedCount,
        unmatchedAmount: data.unmatchedAmount,
      });
    } catch (e: any) {
      setOrphanErr(e?.message || "No se pudo consultar MercadoPago");
    } finally {
      setOrphanLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Kpi title="Recibido en el período" value={clp(kpis.received)} hint={`${kpis.count} pagos`} />
        <Kpi title="Liberado" value={clp(kpis.releasedNet)} hint="Disponible en saldo" tone="green" />
        <Kpi title="Pendiente de liberar" value={clp(kpis.pendingNet)} hint="Aprobado, aún retenido" tone="amber" />
        <Kpi
          title="Matcheado a ventas"
          value={`${kpis.matchedPct}%`}
          hint={`${kpis.orphanCount} pagos sin venta · ${clp(kpis.orphanAmount)}`}
          tone={kpis.orphanCount > 0 ? "red" : "green"}
          onClick={kpis.orphanCount > 0 ? () => onJumpToDetail("orphan") : undefined}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Recibido por día" className="lg:col-span-2">
          {dailySeries.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailySeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => clp(v as number)} />
                <Bar dataKey="net" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Por medio de pago">
          {methodSeries.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={methodSeries} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                  {methodSeries.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: any) => clp(v as number)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Por canal de venta">
          {channelSeries.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={channelSeries} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" tickFormatter={(v) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => clp(v as number)} />
                <Bar dataKey="value" fill="#14b8a6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <div className="lg:col-span-2 bg-white rounded-xl border shadow-card p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Próximas liberaciones</h3>
          {upcomingReleases.length === 0 ? (
            <p className="text-xs text-slate-400">Sin liberaciones futuras pendientes.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-400 border-b">
                  <th className="py-2 font-medium">Fecha</th>
                  <th className="py-2 font-medium text-right">Pagos</th>
                  <th className="py-2 font-medium text-right">Neto a liberar</th>
                </tr>
              </thead>
              <tbody>
                {upcomingReleases.slice(0, 10).map((r) => (
                  <tr key={r.date} className="border-b last:border-0">
                    <td className="py-2 capitalize">
                      {format(new Date(r.date), "EEE dd MMM yyyy", { locale: es })}
                    </td>
                    <td className="py-2 text-right text-slate-500">{r.count}</td>
                    <td className="py-2 text-right tabular-nums font-medium">{clp(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Matching panel */}
      <div className="bg-white rounded-xl border shadow-card p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Matching pagos ↔ ventas</h3>
            <p className="text-xs text-slate-400 mt-1">
              Verifica que cada peso depositado por la pasarela tenga una venta asociada en tu base.
            </p>
          </div>
          <button
            onClick={runOrphanScan}
            disabled={orphanLoading}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-40"
          >
            {orphanLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Buscar huérfanos en MercadoPago
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <MiniStat label="Pagos en período" value={String(kpis.count)} />
          <MiniStat label="Con venta matcheada" value={`${kpis.matchedPct}%`} tone="green" />
          <MiniStat label="Sin venta (locales)" value={String(kpis.orphanCount)} tone={kpis.orphanCount > 0 ? "red" : "slate"} />
          <MiniStat label="Monto sin matchear" value={clp(kpis.orphanAmount)} tone={kpis.orphanAmount > 0 ? "red" : "slate"} />
        </div>

        {orphanErr && (
          <div className="mt-4 text-xs text-red-600 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" /> {orphanErr}
          </div>
        )}
        {orphanRes && (
          <div className="mt-4 p-3 rounded-md bg-slate-50 border text-xs">
            <div className="flex items-center gap-2 mb-1">
              {orphanRes.unmatchedCount === 0
                ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                : <AlertCircle className="h-4 w-4 text-red-600" />}
              <span className="font-medium">
                Revisados {orphanRes.totalChecked} pagos en MercadoPago
              </span>
            </div>
            {orphanRes.unmatchedCount === 0 ? (
              <p className="text-slate-500">Todo lo que la pasarela depositó está reflejado en tu base.</p>
            ) : (
              <p className="text-slate-700">
                {orphanRes.unmatchedCount} pagos por {clp(orphanRes.unmatchedAmount)} existen en MercadoPago pero no se ingestaron.
                Re-sincroniza desde Sincronización para traerlos.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  title, value, hint, tone = "slate", onClick,
}: { title: string; value: string; hint?: string; tone?: "slate" | "green" | "amber" | "red"; onClick?: () => void }) {
  const colorMap = {
    slate: "text-slate-900",
    green: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`bg-white rounded-xl border shadow-card p-4 text-left transition-shadow ${onClick ? "hover:shadow-md cursor-pointer" : "cursor-default"}`}
    >
      <p className="text-xs text-slate-400 mb-1">{title}</p>
      <p className={`text-2xl font-bold tabular-nums ${colorMap[tone]}`}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </button>
  );
}

function ChartCard({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-xl border shadow-card p-4 ${className}`}>
      <h3 className="text-sm font-semibold text-slate-700 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function EmptyChart() {
  return <div className="h-[220px] flex items-center justify-center text-xs text-slate-400">Sin datos</div>;
}

function MiniStat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "green" | "red" }) {
  const map = { slate: "text-slate-900", green: "text-emerald-600", red: "text-red-600" };
  return (
    <div className="border rounded-lg p-3">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={`text-lg font-semibold tabular-nums mt-0.5 ${map[tone]}`}>{value}</p>
    </div>
  );
}