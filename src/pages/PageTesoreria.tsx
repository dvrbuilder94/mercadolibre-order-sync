import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Nav } from "@/components/Nav";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { DetailPanel } from "@/components/DetailPanel";
import { fetchOrderDetail } from "@/lib/orderDetail";
import { TesoreriaResumenFast, type TesoreriaSummary } from "@/components/tesoreria/TesoreriaResumenFast";
import { TesoreriaDetalleFast } from "@/components/tesoreria/TesoreriaDetalleFast";
import { TesoreriaCargos } from "@/components/tesoreria/TesoreriaCargos";
import { clp } from "@/lib/tesoreria";
import { chilePeriodNow } from "@/lib/chileDate";

const EMPTY: TesoreriaSummary = {
  count: 0, gross: 0, fees: 0, net: 0, released_net: 0, pending_net: 0,
  matched_count: 0, partial_count: 0, orphan_count: 0, orphan_amount: 0,
  unpaid_sales: 0, unpaid_amount: 0, paid_without_dte: 0,
  daily: [], methods: [], channels: [], upcoming: [],
};

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

export default function PageTesoreria() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState(chilePeriodNow);
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<"resumen" | "detalle" | "cargos">(
    requestedTab === "detalle" || requestedTab === "cargos" ? requestedTab : "resumen",
  );
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "partial" | "orphan">("all");
  const [summary, setSummary] = useState<TesoreriaSummary>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [detailOrder, setDetailOrder] = useState<any | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { if (!session) navigate("/auth"); });
  }, [navigate]);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc("get_tesoreria_summary", { p_period: period });
      if (error) throw error;
      setSummary({ ...EMPTY, ...(data || {}) });
    } catch (e) {
      console.error("Error cargando resumen de tesorería:", e);
      setSummary(EMPTY);
    } finally { setLoading(false); }
  }, [period]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const openOrderDetail = useCallback(async (id: string) => {
    try { setDetailOrder(await fetchOrderDetail(id)); } catch { /* ignore */ }
  }, []);

  const jumpToDetailFiltered = (filter: "orphan" | "partial") => {
    setMatchFilter(filter);
    setTab("detalle");
    setSearchParams({ tab: "detalle" }, { replace: true });
  };

  const changeTab = (value: string) => {
    const next = value as "resumen" | "detalle" | "cargos";
    setTab(next);
    setSearchParams(next === "resumen" ? {} : { tab: next }, { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Tesorería</h1>
            <p className="text-xs text-slate-400 mt-0.5">Caja operativa multicanal: pagos, liberaciones, diferencias y ventas por explicar.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(`/sync?domain=pagos&period=${period}`)} className="flex items-center gap-2 px-3 py-2 bg-white border rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Sync Pagos
            </button>
            <button onClick={() => changePeriod(-1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-medium capitalize w-36 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <Mini title="Neto aprobado" value={clp(summary.net)} hint={`${summary.count} pagos`} />
          <Mini title="Neto liberado" value={clp(summary.released_net)} hint={`${clp(summary.pending_net)} pendiente`} tone="green" />
          <Mini title="Pagos sin venta" value={String(summary.orphan_count)} hint={summary.partial_count ? `${summary.partial_count} parciales` : "sin parciales"} tone={summary.orphan_count ? "red" : "green"} />
          <Mini title="Ventas por explicar" value={String(summary.unpaid_sales)} hint={`${clp(summary.unpaid_amount)} bruto · ${summary.paid_without_dte} pagadas sin DTE`} tone={summary.unpaid_sales ? "amber" : "green"} />
        </div>

        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="resumen">Resumen</TabsTrigger>
            <TabsTrigger value="detalle">Movimientos <span className="ml-1.5 text-[10px] text-slate-400">({summary.count})</span></TabsTrigger>
            <TabsTrigger value="cargos">Cargos y comisiones</TabsTrigger>
          </TabsList>

          <TabsContent value="resumen">
            {loading ? <Loading /> : <TesoreriaResumenFast summary={summary} onJumpToDetail={jumpToDetailFiltered} />}
          </TabsContent>
          <TabsContent value="detalle">
            <TesoreriaDetalleFast period={period} initialMatchFilter={matchFilter} onOpenOrder={openOrderDetail} />
          </TabsContent>
          <TabsContent value="cargos"><TesoreriaCargos period={period} /></TabsContent>
        </Tabs>
      </main>

      {detailOrder && <DetailPanel title={`Orden ${detailOrder.order_id ?? ""}`} data={detailOrder} onClose={() => setDetailOrder(null)} />}
    </div>
  );
}

function Loading(){return <div className="flex items-center justify-center py-24 text-slate-400 text-sm"><Loader2 className="h-4 w-4 animate-spin mr-2"/>Cargando tesorería…</div>}
function Mini({title,value,hint,tone="slate"}:{title:string;value:string;hint:string;tone?:"slate"|"green"|"red"|"amber"}){const c=tone==="green"?"text-emerald-600":tone==="red"?"text-red-600":tone==="amber"?"text-amber-600":"text-slate-900";return <div className="bg-white border rounded-lg p-4"><p className="text-[11px] uppercase tracking-wider text-slate-400">{title}</p><p className={`text-xl font-bold mt-1 ${c}`}>{value}</p><p className="text-[11px] text-slate-400 mt-1">{hint}</p></div>}
