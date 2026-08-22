import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, ShoppingBag } from "lucide-react";
import { Nav } from "@/components/Nav";
import { VentasModuleNav } from "@/components/ventas/VentasModuleNav";
import { supabase } from "@/integrations/supabase/client";
import { CHANNEL_LABEL } from "@/lib/constants";
import { chilePeriodNow } from "@/lib/chileDate";

type ChannelStat = {
  channel: string;
  count: number;
  amount: number;
  with_document: number;
  without_document: number;
};

type SalesSummary = {
  total: number;
  gross_amount: number;
  with_document: number;
  without_document: number;
  stuck_count: number;
  stuck_amount: number;
  discarded_count: number;
  discarded_amount: number;
  channels: ChannelStat[];
};

const EMPTY: SalesSummary = {
  total: 0,
  gross_amount: 0,
  with_document: 0,
  without_document: 0,
  stuck_count: 0,
  stuck_amount: 0,
  discarded_count: 0,
  discarded_amount: 0,
  channels: [],
};

const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(Number(n || 0));

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

export default function PageVentasResumen() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channel, setChannel] = useState("todos");
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SalesSummary>(EMPTY);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await (supabase as any).rpc("get_ventas_page", {
          p_period: period,
          p_channel: channel,
          p_doc_filter: "todos",
          p_search: "",
          p_limit: 1,
          p_offset: 0,
        });
        if (error) throw error;
        if (!cancelled) setSummary({ ...EMPTY, ...(data || {}) });
      } catch (error) {
        console.error("Error cargando resumen de ventas:", error);
        if (!cancelled) setSummary(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [period, channel]);

  const coverage = summary.total > 0 ? Math.round((summary.with_document / summary.total) * 1000) / 10 : 0;
  const avgTicket = summary.total > 0 ? summary.gross_amount / summary.total : 0;
  const maxAmount = useMemo(() => Math.max(1, ...summary.channels.map((x) => Number(x.amount || 0))), [summary.channels]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
    setChannel("todos");
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3">
              <ShoppingBag className="h-5 w-5 text-slate-400" />
              <h1 className="text-2xl font-semibold text-slate-900">Ventas</h1>
            </div>
            <p className="text-sm text-slate-400 mt-1">Resumen comercial multicanal del período.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(`/sync?domain=ventas&period=${period}`)} className="flex items-center gap-2 px-3 py-2 bg-white border rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Sync Ventas
            </button>
            <button onClick={() => changePeriod(-1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-medium capitalize w-36 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <VentasModuleNav />
          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...Object.keys(CHANNEL_LABEL)].map((ch) => (
              <button key={ch} onClick={() => setChannel(ch)} className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${channel === ch ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"}`}>
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <Kpi label="Ventas" value={loading ? "—" : summary.total.toLocaleString("es-CL")} sub="órdenes válidas" />
          <Kpi label="Venta bruta" value={loading ? "—" : clp(summary.gross_amount)} sub="total del período" />
          <Kpi label="Ticket promedio" value={loading ? "—" : clp(avgTicket)} sub="bruto por venta" />
          <Kpi label="Cobertura DTE" value={loading ? "—" : `${coverage}%`} sub={`${summary.without_document.toLocaleString("es-CL")} sin documento`} tone={summary.without_document ? "amber" : "green"} />
          <Kpi label="Por revisar" value={loading ? "—" : summary.stuck_count.toLocaleString("es-CL")} sub={summary.stuck_count ? `${clp(summary.stuck_amount)} sin confirmar` : `${summary.discarded_count} descartadas`} tone={summary.stuck_count ? "red" : "slate"} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
          <div className="lg:col-span-2 bg-white border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900">Ventas por canal</h2>
                <p className="text-xs text-slate-400 mt-1">Distribución del bruto y volumen por marketplace.</p>
              </div>
              <span className="text-xs text-slate-400">{summary.channels.length} canales activos</span>
            </div>
            {summary.channels.length === 0 ? <p className="text-sm text-slate-400 py-8 text-center">Sin ventas en el período.</p> : (
              <div className="space-y-4">
                {summary.channels.map((row) => (
                  <button key={row.channel} onClick={() => setChannel(row.channel)} className="w-full text-left group">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-700 group-hover:text-slate-900">{CHANNEL_LABEL[row.channel] || row.channel}</span>
                      <span className="text-slate-500">{row.count.toLocaleString("es-CL")} · {clp(row.amount)}</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full mt-2 overflow-hidden"><div className="h-full bg-slate-500" style={{ width: `${(Number(row.amount || 0) / maxAmount) * 100}%` }} /></div>
                    <p className="text-[11px] text-slate-400 mt-1">{row.with_document} con DTE · {row.without_document} sin DTE</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border rounded-xl p-5">
            <h2 className="font-semibold text-slate-900">Salud del período</h2>
            <p className="text-xs text-slate-400 mt-1 mb-5">Excepciones que requieren atención operativa.</p>
            <Metric label="Sin documento" value={summary.without_document} tone={summary.without_document ? "amber" : "green"} />
            <Metric label="Pago sin confirmar" value={summary.stuck_count} tone={summary.stuck_count ? "red" : "green"} />
            <Metric label="Descartadas" value={summary.discarded_count} tone="slate" />
            <button onClick={() => navigate(`/ventas/listado`)} className="mt-5 w-full px-3 py-2 border rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Ver todas las ventas</button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "slate" }: { label: string; value: string; sub: string; tone?: "slate" | "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : tone === "red" ? "text-red-600" : "text-slate-900";
  return <div className="bg-white border rounded-xl p-4"><p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p><p className={`text-xl font-bold mt-1 ${color}`}>{value}</p><p className="text-[11px] text-slate-400 mt-1">{sub}</p></div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "slate" | "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : tone === "red" ? "text-red-600" : "text-slate-700";
  return <div className="flex items-center justify-between py-3 border-b last:border-0"><span className="text-sm text-slate-500">{label}</span><span className={`text-sm font-semibold ${color}`}>{value.toLocaleString("es-CL")}</span></div>;
}
