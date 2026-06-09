import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, GitMerge, Loader2, ExternalLink } from "lucide-react";

interface Stats {
  orders: number;
  docs: number;
  matched: number;
  unmatched: number;
}

interface UnmatchedOrder {
  id: string;
  order_id: string;
  order_date: string;
  gross_amount: number;
  status: string;
  customer_name: string;
}

const CLP = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [stats, setStats] = useState<Stats>({ orders: 0, docs: 0, matched: 0, unmatched: 0 });
  const [unmatched, setUnmatched] = useState<UnmatchedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [syncingML, setSyncingML] = useState(false);
  const [syncingBsale, setSyncingBsale] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  useEffect(() => { fetchStats(); }, [period]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const addLog = (msg: string) => {
    const time = format(new Date(), "HH:mm:ss");
    setLog(prev => [...prev, `${time}  ${msg}`]);
  };

  const fetchStats = async () => {
    setLoading(true);
    try {
      const [y, m] = period.split("-").map(Number);
      const from = format(new Date(y, m - 1, 1), "yyyy-MM-dd");
      const to   = format(new Date(y, m, 0),     "yyyy-MM-dd");

      // Orders for period
      const { count: orderCount } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .gte("order_date", from + "T00:00:00")
        .lte("order_date", to   + "T23:59:59")
        .neq("status", "cancelled");

      // Docs for period
      const { count: docCount } = await supabase
        .from("tax_documents")
        .select("*", { count: "exact", head: true })
        .gte("document_date", from)
        .lte("document_date", to)
        .eq("status", "issued");

      // Matched orders for period
      const { data: orderIds } = await supabase
        .from("orders")
        .select("id")
        .gte("order_date", from + "T00:00:00")
        .lte("order_date", to   + "T23:59:59")
        .neq("status", "cancelled");

      const ids = (orderIds || []).map(o => o.id);
      let matchedCount = 0;
      if (ids.length > 0) {
        const { count } = await supabase
          .from("order_tax_documents")
          .select("*", { count: "exact", head: true })
          .in("order_id", ids);
        matchedCount = count || 0;
      }

      const total = orderCount || 0;
      const matched = Math.min(matchedCount, total);

      setStats({
        orders: total,
        docs: docCount || 0,
        matched,
        unmatched: total - matched,
      });

      // Unmatched orders list
      if (ids.length > 0) {
        const linkedRes = await supabase
          .from("order_tax_documents")
          .select("order_id")
          .in("order_id", ids);
        const linkedIds = new Set((linkedRes.data || []).map(l => l.order_id));
        const unmatchedIds = ids.filter(id => !linkedIds.has(id));

        if (unmatchedIds.length > 0) {
          const { data: rows } = await supabase
            .from("orders")
            .select("id, order_id, order_date, gross_amount, status, customer_name")
            .in("id", unmatchedIds.slice(0, 50))
            .order("order_date", { ascending: false });
          setUnmatched((rows || []) as UnmatchedOrder[]);
        } else {
          setUnmatched([]);
        }
      }
    } catch (e) {
      addLog("❌ Error cargando stats");
    } finally {
      setLoading(false);
    }
  };

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setPeriod(format(d, "yyyy-MM"));
  };

  const syncML = async () => {
    setSyncingML(true);
    addLog("› Sincronizando MercadoLibre...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-meli-orders");
      if (error) throw error;
      addLog(`✅ ML: ${data?.synced || 0} órdenes guardadas`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ ML error: ${e?.message || "desconocido"}`);
    } finally {
      setSyncingML(false);
    }
  };

  const syncBsale = async () => {
    setSyncingBsale(true);
    addLog("› Sincronizando Bsale...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { days_back: 90 },
      });
      if (error) throw error;
      const total = data?.summary?.total_upserted ?? 0;
      addLog(`✅ Bsale: ${total} documentos guardados`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ Bsale error: ${e?.message || "desconocido"}`);
    } finally {
      setSyncingBsale(false);
    }
  };

  const reconcile = async () => {
    setReconciling(true);
    addLog("› Conciliando...");
    try {
      const { data, error } = await supabase.functions.invoke("auto-reconcile");
      if (error) throw error;
      const s = data?.summary || data || {};
      addLog(`✅ Conciliación: ${s.stage3 ?? s.total ?? "?"} vinculadas`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ Conciliación error: ${e?.message || "desconocido"}`);
    } finally {
      setReconciling(false);
    }
  };

  const busy = syncingML || syncingBsale || reconciling;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />

      <main className="flex-1 p-8 max-w-4xl">

        {/* Period selector */}
        <div className="flex items-center gap-3 mb-8">
          <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold capitalize w-40 text-center">
            {periodLabel(period)}
          </h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={fetchStats} className="ml-2 p-1 hover:bg-slate-200 rounded text-slate-400">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "Órdenes ML",  value: stats.orders,    color: "text-slate-800" },
            { label: "Documentos",  value: stats.docs,      color: "text-slate-800" },
            { label: "Vinculadas",  value: stats.matched,   color: "text-green-700" },
            { label: "Sin documento", value: stats.unmatched, color: stats.unmatched > 0 ? "text-red-600" : "text-green-700" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-3xl font-bold ${color}`}>
                {loading ? "—" : value}
              </p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex gap-3 mb-8">
          <button
            onClick={syncML}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-50 text-yellow-900 font-medium rounded-lg text-sm transition-colors"
          >
            {syncingML ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync MercadoLibre
          </button>

          <button
            onClick={syncBsale}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {syncingBsale ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync Bsale
          </button>

          <button
            onClick={reconcile}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {reconciling ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
            Conciliar
          </button>
        </div>

        {/* Log */}
        {log.length > 0 && (
          <div
            ref={logRef}
            className="bg-slate-900 text-slate-100 rounded-lg p-4 mb-8 font-mono text-xs h-32 overflow-y-auto"
          >
            {log.map((line, i) => (
              <p key={i} className={line.includes("❌") ? "text-red-400" : line.includes("✅") ? "text-green-400" : "text-slate-300"}>
                {line}
              </p>
            ))}
          </div>
        )}

        {/* Unmatched orders */}
        {!loading && stats.unmatched > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-red-600">
                ⚠️ {stats.unmatched} órdenes sin documento tributario
              </h2>
              {unmatched.length < stats.unmatched && (
                <span className="text-xs text-slate-400">mostrando {unmatched.length} de {stats.unmatched}</span>
              )}
            </div>
            <div className="bg-white border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50 text-xs text-slate-500">
                    <th className="text-left px-4 py-2 font-medium">Orden</th>
                    <th className="text-left px-4 py-2 font-medium">Fecha</th>
                    <th className="text-left px-4 py-2 font-medium">Cliente</th>
                    <th className="text-right px-4 py-2 font-medium">Monto</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((o) => (
                    <tr key={o.id} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{o.order_id}</td>
                      <td className="px-4 py-2 text-slate-500">{o.order_date?.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-slate-700 max-w-[180px] truncate">{o.customer_name}</td>
                      <td className="px-4 py-2 text-right font-mono">{CLP(o.gross_amount)}</td>
                      <td className="px-4 py-2">
                        <a
                          href={`https://www.mercadolibre.cl/ventas/${o.order_id}/detalle`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-slate-400 hover:text-slate-700"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && stats.unmatched === 0 && stats.orders > 0 && (
          <div className="text-center py-8 text-green-600 font-medium">
            ✅ Todas las órdenes del período tienen documento tributario
          </div>
        )}

      </main>
    </div>
  );
}
