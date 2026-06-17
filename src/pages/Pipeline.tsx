import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, RefreshCw, GitMerge, Loader2,
  UserCheck, ArrowRight, Download, Sparkles, Banknote,
} from "lucide-react";
import { RawApiExtractor } from "@/components/RawApiExtractor";
import { chileMonthUnixRange } from "@/lib/chileDate";

interface Stats {
  orders: number;
  total: number;
  cancelled: number;
  docs: number;
  docsBoleta: number;
  docsFactura: number;
  docsNC: number;
  matched: number;
  unmatched: number;
  pendingPayments: number; // órdenes sin has_exact_data (necesitan sync pagos)
}

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const clp = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n || 0);

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
  const [stats, setStats] = useState<Stats>({
    orders: 0, total: 0, cancelled: 0,
    docs: 0, docsBoleta: 0, docsFactura: 0, docsNC: 0,
    matched: 0, unmatched: 0, pendingPayments: 0,
  });
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [syncingML, setSyncingML] = useState(false);
  const [syncingPayments, setSyncingPayments] = useState(false);
  const [syncingBsale, setSyncingBsale] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastRecon, setLastRecon] = useState<{
    exact: number; pack: number; consolidated: number; auto: number;
  } | null>(null);
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

  const errorDetail = async (error: any): Promise<string> => {
    try {
      const body = await error?.context?.json?.();
      if (body?.error || body?.message) return body.error || body.message;
    } catch { /* ignore */ }
    return error?.message || "error desconocido";
  };

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const PAGE = 1000;
      let offset = 0;
      const orders: any[] = [];
      while (true) {
        const { data, error: ordersErr } = await supabase
          .from("orders")
          .select("id, status, has_exact_data, order_tax_documents(id)")
          .gte("order_date", from + "T00:00:00")
          .lte("order_date", to   + "T23:59:59")
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (ordersErr) throw ordersErr;
        const batch = (data || []) as any[];
        orders.push(...batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
      }

      const docBase = () => supabase
        .from("tax_documents")
        .select("*", { count: "exact", head: true })
        .gte("document_date", from)
        .lte("document_date", to)
        .eq("status", "issued");
      const [docTotal, docBoleta, docFactura, docNC] = await Promise.all([
        docBase(),
        docBase().eq("document_type", "boleta"),
        docBase().eq("document_type", "factura"),
        docBase().eq("document_type", "nota_credito"),
      ]);

      const vigentes = orders.filter(o => o.status !== "cancelled");
      const matched  = vigentes.filter(o => (o.order_tax_documents as any[])?.length > 0);

      setStats({
        orders:          vigentes.length,
        total:           orders.length,
        cancelled:       orders.length - vigentes.length,
        docs:            docTotal.count || 0,
        docsBoleta:      docBoleta.count || 0,
        docsFactura:     docFactura.count || 0,
        docsNC:          docNC.count || 0,
        matched:         matched.length,
        unmatched:       vigentes.length - matched.length,
        pendingPayments: vigentes.filter(o => !o.has_exact_data).length,
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
    const { from, to } = periodRange(period);
    addLog(`› Sincronizando MercadoLibre (${periodLabel(period)})...`);
    try {
      const { data, error } = await supabase.functions.invoke("sync-meli-orders", {
        body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59`, max_pages: 50 },
      });
      if (error) throw error;
      const synced = data?.synced ?? 0;
      const available = data?.available ?? 0;
      const target = available > 0 ? ` de ${available} disponibles en MELI` : "";
      addLog(`✅ ML: ${synced}${target} órdenes sincronizadas`);
      if (data?.partial || data?.timedOut) {
        const faltan = available > 0 ? Math.max(available - synced, 0) : 0;
        addLog(`⚠️ Parcial${faltan ? ` — faltan ~${faltan}` : ""}, volvé a tocar para continuar`);
      }
      fetchStats();
    } catch (e: any) {
      addLog(`❌ ML: ${await errorDetail(e)}`);
    } finally {
      setSyncingML(false);
    }
  };

  const syncPayments = async () => {
    setSyncingPayments(true);
    addLog("› Sincronizando pagos MercadoPago...");
    // Scope to the period currently open in the UI — without date_from/date_to
    // the edge function defaults to "most recent 50 orders without exact data",
    // which silently processes the wrong month when viewing past periods.
    const { from, to } = periodRange(period);
    let totalLinked = 0;
    let round = 0;
    try {
      while (true) {
        round++;
        const { data, error } = await supabase.functions.invoke("sync-meli-payment-details", {
          body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59`, limit: 50 },
        });
        if (error) throw error;
        totalLinked += data?.paymentsLinked ?? 0;
        const remaining = data?.remaining ?? 0;
        if (remaining === 0 || (data?.updated ?? 0) === 0 || round >= 20) {
          addLog(remaining > 0
            ? `⚠️ ${totalLinked} pagos vinculados · faltan ~${remaining}, volvé a tocar para continuar`
            : `✅ Pagos: ${totalLinked} órdenes con datos exactos · backlog completo`
          );
          break;
        }
        addLog(`  Ronda ${round}: ${data?.paymentsLinked ?? 0} vinculados · ${remaining} restantes...`);
      }
      fetchStats();
    } catch (e: any) {
      addLog(`❌ Pagos: ${await errorDetail(e)}`);
    } finally {
      setSyncingPayments(false);
    }
  };

  const syncBsale = async () => {
    setSyncingBsale(true);
    addLog(`› Sincronizando Bsale (${periodLabel(period)})...`);
    try {
      const { from: dateFrom, to: dateTo } = chileMonthUnixRange(period);
      const ckptKey = `bsale_ckpt_${period}`;
      let cursor: { code_sii: number; offset: number } | null = null;
      let batchId: string | null = null;
      let totalUpserted = 0;
      let totalFetched = 0;
      let totalAvailable: number | null = null;
      let totalByType: Record<string, number> = {};
      let partialError: string | null = null;
      let rounds = 0;

      try {
        const saved = JSON.parse(localStorage.getItem(ckptKey) || "null");
        if (saved?.cursor) {
          cursor = saved.cursor;
          batchId = saved.batchId ?? null;
          totalAvailable = saved.totalAvailable ?? null;
          addLog(`↻ Reanudando desde checkpoint (${cursor.code_sii}/${cursor.offset})`);
        }
      } catch { /* checkpoint corrupto */ }

      do {
        rounds += 1;
        const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
          body: {
            date_from: dateFrom, date_to: dateTo, max_pages: 20,
            ...(batchId ? { resync_batch: batchId } : {}),
            ...(cursor ? { start_code_sii: cursor.code_sii, start_offset: cursor.offset } : {}),
          },
        });
        if (error) throw error;

        batchId = data?.resync_batch ?? batchId;
        totalUpserted += data?.summary?.total_upserted ?? 0;
        totalFetched  += data?.summary?.total_fetched ?? 0;
        if (data?.summary?.total_available != null) totalAvailable = data.summary.total_available;
        if (data?.summary?.by_type) {
          for (const [k, v] of Object.entries(data.summary.by_type as Record<string, number>))
            totalByType[k] = (totalByType[k] || 0) + Number(v || 0);
        }
        if (data?.error_detail) partialError = data.error_detail;
        cursor = data?.next_cursor ?? null;
        if (cursor) {
          localStorage.setItem(ckptKey, JSON.stringify({ cursor, batchId, totalAvailable }));
          const metaLbl = totalAvailable ? ` (meta ${totalAvailable})` : "";
          addLog(`› Bsale: ${totalFetched} traídos${metaLbl} · continúa (${cursor.code_sii}/${cursor.offset})...`);
        }
        if (!data?.partial) break;
      } while (cursor && rounds < 8);

      if (!cursor) localStorage.removeItem(ckptKey);

      const byType = Object.keys(totalByType).length > 0
        ? Object.entries(totalByType).map(([k, v]) => `${v} ${k}`).join(" · ")
        : "";
      const enBD = stats.docs;
      const progreso = totalAvailable
        ? ` · en BD: ${enBD} de ${totalAvailable} (${Math.round(enBD / totalAvailable * 100)}%)`
        : "";
      addLog(`✅ Bsale: +${totalUpserted} guardados${byType ? ` (${byType})` : ""}${progreso}`);
      if (cursor || partialError)
        addLog(`⚠️ Bsale parcial${partialError ? ` (${partialError})` : ""} — checkpoint guardado, volvé a tocar y retoma donde quedó`);
      else if (totalAvailable && enBD >= totalAvailable)
        addLog(`🎉 Bsale completo: ${enBD} de ${totalAvailable} documentos del período`);

      fetchStats();
    } catch (e: any) {
      addLog(`❌ Bsale: ${await errorDetail(e)}`);
    } finally {
      setSyncingBsale(false);
    }
  };

  const resetBsale = async () => {
    if (!window.confirm(
      `¿Re-sincronizar Bsale de ${periodLabel(period)} desde cero?\n\n` +
      `Vuelve a leer TODOS los documentos del período. NO borra documentos ni conexiones.`
    )) return;
    localStorage.removeItem(`bsale_ckpt_${period}`);
    addLog(`↺ Bsale ${periodLabel(period)}: reiniciado desde cero`);
    await syncBsale();
  };

  const reconcile = async () => {
    setReconciling(true);
    const { from, to } = periodRange(period);
    addLog(`› Conciliando ${periodLabel(period)}...`);
    try {
      const { data, error } = await supabase.functions.invoke("auto-reconcile", {
        body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` },
      });
      if (error) throw error;
      const s3 = data?.stage3_order_taxdoc || {};
      const exact       = s3.hard_linked ?? 0;
      const packOrders  = s3.hard_linked_pack_id_orders ?? 0;
      const packDocs    = s3.hard_linked_pack_id ?? 0;
      const consolidated = s3.auto_consolidated_orders ?? s3.auto_consolidated ?? 0;
      const auto        = s3.auto_linked ?? 0;
      const nuevas = exact + packOrders + consolidated + auto;
      setLastRecon({ exact, pack: packOrders, consolidated, auto });
      const packLabel = packDocs > 0
        ? `${packOrders} por pack (${packDocs} doc${packDocs === 1 ? "" : "s"})`
        : `${packOrders} por pack`;
      await fetchStats();
      addLog(`✅ Conciliación: +${nuevas} nuevas · ${exact} exactas · ${packLabel} · ${consolidated} consolidadas · ${auto} por score`);
      if (s3.ambiguous > 0) addLog(`⚠️ ${s3.ambiguous} ambiguas — requieren revisión manual`);
    } catch (e: any) {
      addLog(`❌ Conciliación: ${await errorDetail(e)}`);
    } finally {
      setReconciling(false);
    }
  };

  const reconcileFromScratch = async () => {
    if (!window.confirm(
      `¿Re-conciliar ${periodLabel(period)} desde cero?\n\n` +
      `Borra las VINCULACIONES del período y rehace el match. NO borra órdenes ni documentos.`
    )) return;
    setReconciling(true);
    try {
      const { from, to } = periodRange(period);
      const PAGE = 1000; let offset = 0; const ids: string[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("orders").select("id")
          .gte("order_date", from + "T00:00:00").lte("order_date", to + "T23:59:59")
          .order("id", { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data || []) as any[];
        ids.push(...batch.map(o => o.id));
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const { error, count } = await supabase
          .from("order_tax_documents").delete({ count: "exact" })
          .in("order_id", ids.slice(i, i + 200));
        if (error) throw error;
        deleted += count || 0;
      }
      addLog(`↺ ${periodLabel(period)}: ${deleted} vínculos borrados — re-conciliando limpio...`);
    } catch (e: any) {
      addLog(`❌ Reset conciliación: ${await errorDetail(e)}`);
      setReconciling(false);
      return;
    }
    await reconcile();
  };

  const enrichRuts = async () => {
    setEnriching(true);
    addLog("› Enriqueciendo RUTs desde API de ML...");
    // Same date-scope issue as syncPayments: without bounds this defaults to
    // the 150 most recent orders, ignoring the period shown in the UI.
    const { from, to } = periodRange(period);
    let totalEnriched = 0; let round = 0;
    try {
      while (true) {
        round++;
        const { data, error } = await supabase.functions.invoke("enrich-meli-billing", {
          body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` },
        });
        if (error) throw error;
        const enriched  = data?.enriched ?? 0;
        const remaining = data?.remaining ?? 0;
        totalEnriched += enriched;
        addLog(`  Ronda ${round}: ${enriched} RUTs obtenidos · ${remaining} pendientes`);
        if (remaining === 0 || enriched === 0) break;
        if (round >= 50) { addLog("  ⚠️ Límite de rondas alcanzado"); break; }
      }
      addLog(`✅ RUTs: ${totalEnriched} órdenes enriquecidas`);
      fetchStats();
    } catch (e: any) {
      addLog(`❌ RUTs: ${await errorDetail(e)}`);
    } finally {
      setEnriching(false);
    }
  };

  const busy = syncingML || syncingPayments || syncingBsale || reconciling || enriching;

  const exportSample = async (includeRaw = false) => {
    setExporting(true);
    addLog(`› Exportando ${includeRaw ? "RAW" : "muestra"} JSON de ${period}...`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sesión expirada");
      const url = `https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/export-monthly-sample`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ period, include_raw: includeRaw }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `quadra-${includeRaw ? "raw" : "sample"}-${period}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      addLog(`✅ ${includeRaw ? "RAW" : "Muestra"} descargada (${sizeMB} MB)`);
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
          <h1 className="text-xl font-semibold capitalize w-44 text-center">{periodLabel(period)}</h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={fetchStats} disabled={loading}
            className="ml-2 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Estado del período — 4 indicadores operacionales */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "Órdenes ML", value: stats.total, color: "text-slate-800",
              caption: stats.total > 0
                ? `${stats.orders} activas · ${stats.cancelled} canceladas (${Math.round(stats.cancelled / Math.max(stats.total, 1) * 100)}%)`
                : null, progress: null as number | null },
            { label: "Documentos Bsale", value: stats.docs, color: "text-slate-800",
              caption: stats.docs > 0
                ? `${stats.docsBoleta} boletas · ${stats.docsFactura} facturas · ${stats.docsNC} n.crédito`
                : null, progress: null },
            { label: "Conciliadas", value: stats.matched, color: "text-green-700",
              caption: stats.orders > 0
                ? `${stats.matched}/${stats.orders} · ${Math.round(stats.matched / Math.max(stats.orders, 1) * 100)}% cobertura${lastRecon ? ` · +${lastRecon.exact + lastRecon.pack + lastRecon.consolidated + lastRecon.auto} esta corrida` : ""}`
                : null,
              progress: stats.orders > 0 ? stats.matched / stats.orders : 0 },
            { label: "Sin documento", value: stats.unmatched,
              color: loading ? "text-slate-400" : stats.unmatched > 0 ? "text-red-600" : "text-green-700",
              caption: stats.unmatched > 0 ? "ventas sin respaldo tributario" : null, progress: null },
          ].map(({ label, value, color, caption, progress }) => (
            <div key={label} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-3xl font-bold ${color}`}>
                {loading ? <span className="text-slate-300">—</span> : value}
              </p>
              {progress !== null && !loading && (
                <div className="h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {caption && !loading && (
                <p className="text-[10px] leading-tight text-slate-400 mt-1">{caption}</p>
              )}
            </div>
          ))}
        </div>

        {/* Pasos del workflow */}
        <p className="text-xs text-slate-400 mb-2">Ejecutar en orden:</p>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <button onClick={syncML} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-40 text-yellow-900 font-medium rounded-lg text-sm transition-colors">
            {syncingML ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            1. Sync MeLi
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button onClick={syncPayments} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors">
            {syncingPayments ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
            2. Sync pagos
            {!loading && stats.pendingPayments > 0 && (
              <span className="bg-white/20 text-[10px] px-1.5 py-0.5 rounded-full font-normal">
                {stats.pendingPayments} pend.
              </span>
            )}
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button onClick={syncBsale} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors">
            {syncingBsale ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            3. Sync Bsale
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button onClick={enrichRuts} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700 font-medium rounded-lg text-sm transition-colors">
            {enriching ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
            4. RUTs
          </button>

          <ArrowRight className="h-4 w-4 text-slate-300 shrink-0" />

          <button onClick={reconcile} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors">
            {reconciling ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
            5. Conciliar
          </button>
        </div>

        {/* Acciones avanzadas */}
        <div className="mb-8 flex flex-col gap-1">
          <button onClick={resetBsale} disabled={busy}
            className="text-xs text-slate-400 hover:text-blue-600 disabled:opacity-40 underline underline-offset-2 text-left w-fit">
            ↺ Re-sincronizar Bsale de {periodLabel(period)} desde cero
            <span className="text-slate-300 no-underline ml-2">(si quedó con datos viejos)</span>
          </button>
          <button onClick={reconcileFromScratch} disabled={busy}
            className="text-xs text-slate-400 hover:text-blue-600 disabled:opacity-40 underline underline-offset-2 text-left w-fit">
            ↺ Re-conciliar {periodLabel(period)} desde cero
            <span className="text-slate-300 no-underline ml-2">(borra los vínculos y rehace el match — no borra documentos)</span>
          </button>
        </div>

        {/* Raw API extractor */}
        <RawApiExtractor period={period} onLog={addLog} />

        {/* Export */}
        <div className="bg-white border rounded-lg p-4 mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                Exportar para análisis externo (Grok / ChatGPT / Claude)
              </p>
              <p className="text-xs text-slate-500 mt-1">
                <b>Normalizado</b>: datos del modelo Quadra (liviano).{" "}
                <b>RAW</b>: respuestas originales de MELI y Bsale (puede pesar varios MB).
              </p>
            </div>
            <div className="shrink-0 flex flex-col gap-2">
              <button onClick={() => exportSample(false)} disabled={exporting || busy}
                className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors">
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Normalizado
              </button>
              <button onClick={() => exportSample(true)} disabled={exporting || busy}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors">
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                RAW (API nativa)
              </button>
            </div>
          </div>
        </div>

        {/* Log terminal */}
        {log.length > 0 && (
          <div ref={logRef}
            className="bg-slate-900 text-slate-100 rounded-lg p-4 mb-8 font-mono text-xs h-36 overflow-y-auto">
            {log.map((line, i) => (
              <p key={i} className={
                line.includes("❌") ? "text-red-400" :
                line.includes("✅") ? "text-green-400" :
                line.includes("⚠️") ? "text-yellow-400" : "text-slate-400"
              }>{line}</p>
            ))}
          </div>
        )}

        {!loading && stats.unmatched > 0 && (
          <div className="bg-white border rounded-lg p-4 flex items-center justify-between">
            <p className="text-sm text-red-600 font-medium">
              ⚠️ {stats.unmatched} órdenes sin documento tributario en este período
            </p>
            <button onClick={() => navigate("/ventas")}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
              Ver en Ventas <ArrowRight className="h-3.5 w-3.5" />
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
            Sin órdenes para este período. Prueba Sync MeLi.
          </p>
        )}

      </main>
    </div>
  );
}
