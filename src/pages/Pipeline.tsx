import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, GitMerge, Loader2, UserCheck, ArrowRight, Download, Sparkles } from "lucide-react";

interface Stats {
  orders: number;
  docs: number;
  matched: number;
  unmatched: number;
}

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};

export default function Pipeline() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [stats, setStats] = useState<Stats>({ orders: 0, docs: 0, matched: 0, unmatched: 0 });
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [syncingML, setSyncingML] = useState(false);
  const [syncingBsale, setSyncingBsale] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const addLog = (msg: string) => {
    const time = format(new Date(), "HH:mm:ss");
    setLog(prev => [...prev, `${time}  ${msg}`]);
  };

  // One query: fetch orders with their links — avoids .in() with huge ID arrays
  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);

      // Orders + their links in one query (max 1000)
      const { data: orders, error: ordersErr } = await supabase
        .from("orders")
        .select("id, order_tax_documents(id)")
        .gte("order_date", from + "T00:00:00")
        .lte("order_date", to   + "T23:59:59")
        .neq("status", "cancelled")
        .limit(1000);

      if (ordersErr) throw ordersErr;

      // Docs count
      const { count: docCount, error: docsErr } = await supabase
        .from("tax_documents")
        .select("*", { count: "exact", head: true })
        .gte("document_date", from)
        .lte("document_date", to)
        .eq("status", "issued");

      if (docsErr) throw docsErr;

      const all = orders || [];
      const matched = all.filter(o => (o.order_tax_documents as any[])?.length > 0);
      const unmatchedCount = all.length - matched.length;

      setStats({
        orders:    all.length,
        docs:      docCount || 0,
        matched:   matched.length,
        unmatched: unmatchedCount,
      });
    } catch (e: any) {
      addLog(`❌ Error cargando datos: ${e?.message || "desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
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
      addLog(`❌ ML: ${e?.message || "error desconocido"}`);
    } finally {
      setSyncingML(false);
    }
  };

  const syncBsale = async () => {
    setSyncingBsale(true);
    addLog("› Sincronizando Bsale (últimos 90 días)...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { days_back: 90 },
      });
      if (error) throw error;
      const total = data?.summary?.total_upserted ?? 0;
      const byType = data?.summary?.by_type
        ? Object.entries(data.summary.by_type).map(([k, v]) => `${v} ${k}`).join(" · ")
        : "";
      addLog(`✅ Bsale: ${total} documentos${byType ? ` (${byType})` : ""}`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ Bsale: ${e?.message || "error desconocido"}`);
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
      const s3 = data?.stage3_order_taxdoc || {};
      const hard = s3.hard_linked ?? 0;
      const consolidated = s3.auto_consolidated ?? 0;
      const auto = s3.auto_linked ?? 0;
      const total3 = hard + consolidated + auto;
      addLog(`✅ Conciliación: ${total3} vinculadas (${hard} exactas · ${consolidated} consolidadas · ${auto} por score)`);
      if (s3.ambiguous > 0) addLog(`⚠️ ${s3.ambiguous} ambiguas — requieren revisión manual`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ Conciliación: ${e?.message || "error desconocido"}`);
    } finally {
      setReconciling(false);
    }
  };

  const enrichRuts = async () => {
    setEnriching(true);
    addLog("› Enriqueciendo RUTs desde API de ML...");
    let totalEnriched = 0;
    let round = 0;
    try {
      while (true) {
        round++;
        const { data, error } = await supabase.functions.invoke("enrich-meli-billing");
        if (error) throw error;
        const enriched = data?.enriched ?? 0;
        const remaining = data?.remaining ?? 0;
        totalEnriched += enriched;
        addLog(`  Ronda ${round}: ${enriched} RUTs obtenidos · ${remaining} pendientes`);
        if (remaining === 0 || enriched === 0) break;
        if (round >= 50) { addLog("  ⚠️ Límite de rondas alcanzado"); break; }
      }
      addLog(`✅ RUTs: ${totalEnriched} órdenes enriquecidas en ${round} ronda${round > 1 ? "s" : ""}`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ RUTs: ${e?.message || "error desconocido"}`);
    } finally {
      setEnriching(false);
    }
  };

  const busy = syncingML || syncingBsale || reconciling || enriching;

  const exportSample = async () => {
    setExporting(true);
    addLog(`› Exportando muestra JSON de ${period}...`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sesión expirada");
      const url = `https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/export-monthly-sample`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ period, include_raw: false }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `quadra-sample-${period}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      addLog(`✅ Muestra descargada (${sizeMB} MB) — súbela a Grok/ChatGPT/Claude`);
    } catch (e: any) {
      addLog(`❌ Export: ${e?.message || "error"}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />

      <main className="flex-1 p-8 max-w-4xl">

        {/* Period selector */}
        <div className="flex items-center gap-3 mb-8">
          <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold capitalize w-44 text-center">
            {periodLabel(period)}
          </h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button
            onClick={fetchStats}
            disabled={loading}
            className="ml-2 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "Órdenes ML",     value: stats.orders,    color: "text-slate-800" },
            { label: "Documentos",     value: stats.docs,      color: "text-slate-800" },
            { label: "Vinculadas",     value: stats.matched,   color: "text-green-700" },
            { label: "Sin documento",  value: stats.unmatched,
              color: loading ? "text-slate-400" : stats.unmatched > 0 ? "text-red-600" : "text-green-700" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-3xl font-bold ${color}`}>
                {loading ? <span className="text-slate-300">—</span> : value}
              </p>
            </div>
          ))}
        </div>

        {/* Pipeline steps */}
        <p className="text-xs text-slate-400 mb-2">Ejecutar en orden:</p>
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          <button
            onClick={syncML}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-40 text-yellow-900 font-medium rounded-lg text-sm transition-colors"
          >
            {syncingML ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            1. Sync MercadoLibre
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button
            onClick={syncBsale}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {syncingBsale ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            2. Sync Bsale
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button
            onClick={enrichRuts}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700 font-medium rounded-lg text-sm transition-colors"
          >
            {enriching ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
            3. Enriquecer RUTs
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button
            onClick={reconcile}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {reconciling ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
            4. Conciliar
          </button>
        </div>

        {/* Export sample for external LLM analysis */}
        <div className="bg-white border rounded-lg p-4 mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                Muestra para análisis externo (Grok / ChatGPT / Claude)
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Descarga un JSON con todas las ventas MELI, documentos Bsale, pagos y matches existentes de {periodLabel(period)}. Súbelo al LLM con un prompt de matching para validar coincidencias.
              </p>
            </div>
            <button
              onClick={exportSample}
              disabled={exporting || busy}
              className="shrink-0 flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Descargar JSON
            </button>
          </div>
        </div>

        {/* Log terminal */}
        {log.length > 0 && (
          <div
            ref={logRef}
            className="bg-slate-900 text-slate-100 rounded-lg p-4 mb-8 font-mono text-xs h-36 overflow-y-auto"
          >
            {log.map((line, i) => (
              <p
                key={i}
                className={
                  line.includes("❌") ? "text-red-400" :
                  line.includes("✅") ? "text-green-400" :
                  line.includes("⚠️") ? "text-yellow-400" :
                  "text-slate-400"
                }
              >
                {line}
              </p>
            ))}
          </div>
        )}

        {/* Unmatched summary → link to detail page */}
        {!loading && stats.unmatched > 0 && (
          <div className="bg-white border rounded-lg p-4 flex items-center justify-between">
            <p className="text-sm text-red-600 font-medium">
              ⚠️ {stats.unmatched} órdenes sin documento tributario en este período
            </p>
            <button
              onClick={() => navigate("/mercadolibre")}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              Ver detalle <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {!loading && stats.unmatched === 0 && stats.orders > 0 && (
          <p className="text-center py-8 text-green-600 font-medium">
            ✅ Todas las órdenes del período tienen documento tributario
          </p>
        )}

        {!loading && stats.orders === 0 && (
          <p className="text-center py-8 text-slate-400 text-sm">
            Sin órdenes para este período. Prueba Sync MercadoLibre.
          </p>
        )}

      </main>
    </div>
  );
}
