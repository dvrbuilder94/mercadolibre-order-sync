import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, GitMerge, Loader2, UserCheck, ArrowRight, Download, Sparkles } from "lucide-react";
import { RawApiExtractor } from "@/components/RawApiExtractor";

interface Stats {
  orders: number;      // órdenes vigentes (no canceladas) — base de la conciliación
  total: number;       // todas las órdenes del período (incl. canceladas)
  cancelled: number;
  docs: number;
  docsBoleta: number;
  docsFactura: number;
  docsNC: number;      // notas de crédito (devoluciones)
  matched: number;
  unmatched: number;
  grossSales: number;  // Σ gross_amount (ventas brutas)
  totalFees: number;   // Σ comisión + financiamiento
  netEconomic: number; // bruto − fees
  ivaVentas: number;   // Σ vat_amount (IVA débito de ventas)
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

// Convert a wall-clock instant (Y/M/D h:m:s) interpreted in America/Santiago
// to a unix timestamp (seconds). Bsale's emissionDate is stored in Chile time,
// so the period range must be anchored to Chile's calendar, not UTC.
const chileWallToUnix = (
  year: number, month: number, day: number,
  hour: number, min: number, sec: number
): number => {
  let ts = Date.UTC(year, month - 1, day, hour, min, sec);
  const target = ts;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    const curr = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    const diff = target - curr;
    if (diff === 0) break;
    ts += diff;
  }
  return Math.floor(ts / 1000);
};

const chileMonthUnixRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: chileWallToUnix(y, m, 1, 0, 0, 0),
    to:   chileWallToUnix(y, m, lastDay, 23, 59, 59),
  };
};

export default function Pipeline() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [stats, setStats] = useState<Stats>({
    orders: 0, total: 0, cancelled: 0,
    docs: 0, docsBoleta: 0, docsFactura: 0, docsNC: 0,
    matched: 0, unmatched: 0,
    grossSales: 0, totalFees: 0, netEconomic: 0, ivaVentas: 0,
  });
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [syncingML, setSyncingML] = useState(false);
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

  // supabase.functions.invoke() solo da "Edge Function returned a non-2xx status code"
  // en error.message; el detalle real viene en el body de error.context.
  const errorDetail = async (error: any): Promise<string> => {
    try {
      const body = await error?.context?.json?.();
      if (body?.error || body?.message) return body.error || body.message;
    } catch {
      // ignore, fall back below
    }
    return error?.message || "error desconocido";
  };

  // One query: fetch orders with their links — avoids .in() with huge ID arrays
  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);

      // Órdenes + links + campos contables — paginado: Supabase corta en 1000
      // filas por request, así que traemos en páginas hasta agotar. Incluimos
      // canceladas (se filtran client-side) para poder mostrarlas aparte.
      const PAGE = 1000;
      let offset = 0;
      const orders: any[] = [];
      while (true) {
        const { data, error: ordersErr } = await supabase
          .from("orders")
          .select("id, status, gross_amount, commission_amount, financing_fee, net_amount, vat_amount, order_tax_documents(id)")
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

      // Documentos: total + desglose por tipo (conteos head, sin traer filas)
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
      const firstErr = [docTotal, docBoleta, docFactura, docNC].find(r => r.error);
      if (firstErr?.error) throw firstErr.error;

      const num = (v: any) => Number(v) || 0;
      const vigentes = orders.filter(o => o.status !== "cancelled");
      const matched = vigentes.filter(o => (o.order_tax_documents as any[])?.length > 0);
      const grossSales = vigentes.reduce((s, o) => s + num(o.gross_amount), 0);
      const totalFees  = vigentes.reduce((s, o) => s + num(o.commission_amount) + num(o.financing_fee), 0);
      // vat_amount no se puebla en el sync (queda en 0). Si algún día se puebla
      // lo usamos; si no, estimamos el IVA débito como la parte afecta del bruto
      // (bruto = neto × 1,19 → IVA = bruto − bruto/1,19). El exacto saldrá de
      // sumar tax_amount de los documentos Bsale (pendiente en BACKLOG).
      const ivaReal = vigentes.reduce((s, o) => s + num(o.vat_amount), 0);
      const ivaVentas = ivaReal > 0 ? ivaReal : Math.round(grossSales - grossSales / 1.19);

      const next: Stats = {
        orders:      vigentes.length,
        total:       orders.length,
        cancelled:   orders.length - vigentes.length,
        docs:        docTotal.count || 0,
        docsBoleta:  docBoleta.count || 0,
        docsFactura: docFactura.count || 0,
        docsNC:      docNC.count || 0,
        matched:     matched.length,
        unmatched:   vigentes.length - matched.length,
        grossSales,
        totalFees,
        netEconomic: grossSales - totalFees,
        ivaVentas,
      };
      setStats(next);
      return next;
    } catch (e: any) {
      addLog(`❌ Error cargando datos: ${e?.message || "desconocido"}`);
      return null;
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
        body: {
          date_from: `${from}T00:00:00`,
          date_to: `${to}T23:59:59`,
          max_pages: 50,
        },
      });
      if (error) throw error;
      const synced = data?.synced ?? 0;
      const available = data?.available ?? 0;
      const target = available > 0 ? ` de ${available} disponibles en MELI` : "";
      addLog(`✅ ML: ${synced}${target} órdenes sincronizadas`);
      if (data?.partial || data?.timedOut) {
        const faltan = available > 0 ? Math.max(available - synced, 0) : 0;
        addLog(`⚠️ Parcial${faltan ? ` — faltan ~${faltan}` : ""}, volvé a tocar "Sincronizar MercadoLibre" para continuar`);
      }
      fetchStats();
    } catch (e: any) {
      addLog(`❌ ML: ${await errorDetail(e)}`);
    } finally {
      setSyncingML(false);
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
      let totalAvailable: number | null = null;  // meta: total de docs en Bsale del período
      let totalByType: Record<string, number> = {};
      let partialError: string | null = null;
      let rounds = 0;

      // Checkpoint: si una corrida anterior quedó a medias, reanudamos desde
      // donde quedó en vez de dar toda la vuelta de nuevo.
      try {
        const saved = JSON.parse(localStorage.getItem(ckptKey) || "null");
        if (saved?.cursor) {
          cursor = saved.cursor;
          batchId = saved.batchId ?? null;
          totalAvailable = saved.totalAvailable ?? null;
          addLog(`↻ Reanudando desde checkpoint (${cursor.code_sii}/${cursor.offset})`);
        }
      } catch { /* checkpoint corrupto, empezamos de cero */ }

      do {
        rounds += 1;
        const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
          body: {
            date_from: dateFrom,
            date_to: dateTo,
            max_pages: 20,
            ...(batchId ? { resync_batch: batchId } : {}),
            ...(cursor ? { start_code_sii: cursor.code_sii, start_offset: cursor.offset } : {}),
          },
        });
        if (error) throw error;

        batchId = data?.resync_batch ?? batchId;
        totalUpserted += data?.summary?.total_upserted ?? 0;
        totalFetched += data?.summary?.total_fetched ?? 0;
        if (data?.summary?.total_available != null) totalAvailable = data.summary.total_available;
        if (data?.summary?.by_type) {
          for (const [k, v] of Object.entries(data.summary.by_type as Record<string, number>)) {
            totalByType[k] = (totalByType[k] || 0) + Number(v || 0);
          }
        }

        if (data?.error_detail) partialError = data.error_detail;
        cursor = data?.next_cursor ?? null;
        if (cursor) {
          // Persistimos el checkpoint en cada ronda: si cierras la pestaña a
          // mitad, el próximo click retoma acá.
          localStorage.setItem(ckptKey, JSON.stringify({ cursor, batchId, totalAvailable }));
          const metaLbl = totalAvailable ? ` (meta ${totalAvailable})` : "";
          addLog(`› Bsale: ${totalFetched} traídos esta tanda${metaLbl} · continúa (${cursor.code_sii}/${cursor.offset})...`);
        }
        if (!data?.partial) break;
      } while (cursor && rounds < 8);

      // Completó todo el período → limpiamos el checkpoint.
      if (!cursor) localStorage.removeItem(ckptKey);

      const byType = Object.keys(totalByType).length > 0
        ? Object.entries(totalByType).map(([k, v]) => `${v} ${k}`).join(" · ")
        : "";
      // Refrescamos para reportar el progreso REAL (documentos ya en la BD vs meta).
      const fresh = await fetchStats();
      const enBD = fresh?.docs ?? stats.docs;
      const progreso = totalAvailable
        ? ` · en BD: ${enBD} de ${totalAvailable} (${Math.round(enBD / totalAvailable * 100)}%)`
        : "";
      addLog(`✅ Bsale: +${totalUpserted} guardados esta tanda${byType ? ` (${byType})` : ""}${progreso}`);
      if (cursor || partialError) {
        addLog(`⚠️ Bsale parcial${partialError ? ` (${partialError})` : ""} — checkpoint guardado, volvé a tocar "Sync Bsale" y retoma donde quedó`);
      } else if (totalAvailable && enBD >= totalAvailable) {
        addLog(`🎉 Bsale completo: ${enBD} de ${totalAvailable} documentos del período`);
      }
    } catch (e: any) {
      addLog(`❌ Bsale: ${await errorDetail(e)}`);
    } finally {
      setSyncingBsale(false);
    }
  };

  const reconcile = async () => {
    setReconciling(true);
    const { from, to } = periodRange(period);
    addLog(`› Conciliando ${periodLabel(period)}...`);
    try {
      const { data, error } = await supabase.functions.invoke("auto-reconcile", {
        body: {
          date_from: `${from}T00:00:00`,
          date_to: `${to}T23:59:59`,
        },
      });
      if (error) throw error;
      const s3 = data?.stage3_order_taxdoc || {};
      // Contamos ÓRDENES vinculadas (no docs): el match por pack es 1:N, un doc
      // puede cubrir varias órdenes, así que usamos los contadores *_orders.
      const exact = s3.hard_linked ?? 0;
      const packOrders = s3.hard_linked_pack_id_orders ?? 0;
      const packDocs = s3.hard_linked_pack_id ?? 0;
      const consolidated = s3.auto_consolidated_orders ?? s3.auto_consolidated ?? 0;
      const auto = s3.auto_linked ?? 0;
      const nuevas = exact + packOrders + consolidated + auto;
      setLastRecon({ exact, pack: packOrders, consolidated, auto });
      const packLabel = packDocs > 0
        ? `${packOrders} por pack (${packDocs} doc${packDocs === 1 ? "" : "s"})`
        : `${packOrders} por pack`;
      // Refrescamos primero para reportar el ACUMULADO real (no solo el delta).
      const fresh = await fetchStats();
      if (fresh) {
        addLog(`✅ Conciliación: ${fresh.matched}/${fresh.orders} órdenes vinculadas · +${nuevas} nuevas esta corrida · faltan ${fresh.unmatched}`);
      } else {
        addLog(`✅ Conciliación: +${nuevas} órdenes vinculadas esta corrida`);
      }
      if (nuevas > 0) {
        addLog(`   ↳ ${exact} exactas · ${packLabel} · ${consolidated} consolidadas · ${auto} por score`);
      }
      if (s3.ambiguous > 0) addLog(`⚠️ ${s3.ambiguous} ambiguas — requieren revisión manual`);
    } catch (e: any) {
      addLog(`❌ Conciliación: ${await errorDetail(e)}`);
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
      addLog(`❌ RUTs: ${await errorDetail(e)}`);
    } finally {
      setEnriching(false);
    }
  };

  const busy = syncingML || syncingBsale || reconciling || enriching;

  const exportSample = async (includeRaw = false) => {
    setExporting(true);
    addLog(`› Exportando ${includeRaw ? "RAW (API nativa)" : "muestra"} JSON de ${period}...`);
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
        body: JSON.stringify({ period, include_raw: includeRaw }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `quadra-${includeRaw ? "raw" : "sample"}-${period}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
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
            { label: "Órdenes ML",     value: stats.total,     color: "text-slate-800",
              caption: stats.total > 0
                ? `${stats.orders} pagadas · ${stats.cancelled} canceladas (${Math.round(stats.cancelled / stats.total * 100)}%)`
                : null,
              progress: null as number | null },
            { label: "Documentos",     value: stats.docs,      color: "text-slate-800",
              caption: stats.docs > 0
                ? `${stats.docsBoleta} boletas · ${stats.docsFactura} facturas · ${stats.docsNC} n.crédito`
                : null,
              progress: null },
            { label: "Vinculadas",     value: stats.matched,   color: "text-green-700",
              caption: stats.orders > 0
                ? `${stats.matched}/${stats.orders} · ${Math.round(stats.matched / stats.orders * 100)}% cobertura · faltan ${stats.unmatched}${lastRecon ? ` · +${lastRecon.exact + lastRecon.pack + lastRecon.consolidated + lastRecon.auto} esta corrida` : ""}`
                : null,
              progress: stats.orders > 0 ? stats.matched / stats.orders : 0 },
            { label: "Sin documento",  value: stats.unmatched,
              color: loading ? "text-slate-400" : stats.unmatched > 0 ? "text-red-600" : "text-green-700",
              caption: stats.unmatched > 0 ? "ventas pagadas sin respaldo tributario" : null, progress: null },
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

        {/* KPIs contables ($) */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "Ventas brutas", value: stats.grossSales, color: "text-slate-800",
              hint: "Total vendido al cliente, antes de comisiones." },
            { label: "Fees MELI",     value: stats.totalFees,  color: "text-orange-600",
              hint: "Comisión + financiamiento cobrados por Mercado Libre." },
            { label: "Neto",          value: stats.netEconomic, color: "text-green-700",
              hint: "Ingreso del negocio: ventas brutas − fees." },
            { label: "IVA ventas (est.)", value: stats.ivaVentas, color: "text-slate-800",
              hint: "Estimado: 19% de la parte afecta del bruto. El exacto saldrá de sumar el IVA de los documentos Bsale emitidos." },
          ].map(({ label, value, color, hint }) => (
            <div key={label} className="bg-white border rounded-lg p-4" title={hint}>
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>
                {loading ? <span className="text-slate-300">—</span> : clp(value)}
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

        {/* Raw API extractor (Meli + Bsale) */}
        <RawApiExtractor period={period} onLog={addLog} />

        {/* Export sample for external LLM analysis */}
        <div className="bg-white border rounded-lg p-4 mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                Muestra para análisis externo (Grok / ChatGPT / Claude)
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Descarga un JSON de {periodLabel(period)}. <b>Normalizado</b>: datos transformados al modelo Quadra (liviano). <b>RAW</b>: respuestas originales de MELI y Bsale tal como llegaron de la API (incluye <code>raw_data</code>, puede pesar varios MB).
              </p>
            </div>
            <div className="shrink-0 flex flex-col gap-2">
              <button
                onClick={() => exportSample(false)}
                disabled={exporting || busy}
                className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Normalizado
              </button>
              <button
                onClick={() => exportSample(true)}
                disabled={exporting || busy}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition-colors"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                RAW (API nativa)
              </button>
            </div>
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
