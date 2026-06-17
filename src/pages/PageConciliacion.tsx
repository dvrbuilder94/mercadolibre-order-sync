import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, ExternalLink, Loader2 } from "lucide-react";
import { SCORE_OK } from "@/lib/constants";

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

const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 })
    .format(n || 0);

const PAGE_SIZE = 50;

// Matches por ID determinístico: se consideran conciliados sin revisión humana.
const HARD_SOURCES = new Set([
  "AUTO_HARD_ORDER_ID", "AUTO_HARD_PACK_ID", "AUTO_CONSOLIDATED",
  "webhook_external_order_id", "webhook_fallback_boleta",
]);

// match_source → etiqueta + estilo, en lenguaje de negocio (no nombres
// internos del motor de matching). Se usa tanto en el badge de cada fila
// como en el resumen agregado de "cómo conciliaron" más abajo.
const MATCH_META: Record<string, { label: string; cls: string }> = {
  AUTO_HARD_ORDER_ID:      { label: "Exacta",         cls: "bg-green-100 text-green-700" },
  AUTO_HARD_PACK_ID:       { label: "Multiventa",     cls: "bg-blue-100 text-blue-700" },
  AUTO_CONSOLIDATED:       { label: "Consolidada",    cls: "bg-indigo-100 text-indigo-700" },
  AUTO:                    { label: "Automático",     cls: "bg-amber-100 text-amber-700" },
  AUTO_SOFT:               { label: "Confianza baja", cls: "bg-amber-100 text-amber-700" },
  AUTO_TIE_BREAK:          { label: "Desempate",      cls: "bg-amber-100 text-amber-700" },
  webhook_external_order_id: { label: "Exacta",       cls: "bg-green-100 text-green-700" },
  webhook_fallback_boleta:   { label: "Exacta",       cls: "bg-green-100 text-green-700" },
};
const matchMeta = (src: string | null) =>
  (src && MATCH_META[src]) || { label: src || "Manual", cls: "bg-slate-100 text-slate-600" };

interface Doc {
  id: string;
  document_number: string;
  document_type: string;
  total_amount: number;
  external_url: string | null;
}
interface Link {
  match_source: string | null;
  match_score: number | null;
  allocated_amount: number | null;
  tax_documents: Doc | Doc[] | null;
}
interface OrderRow {
  id: string;
  order_id: string;
  order_date: string;
  status: string;
  product_title: string | null;
  gross_amount: number | null;
  amount: number;
  net_amount: number | null;
  money_release_date: string | null;
  has_exact_data: boolean | null;
  order_tax_documents: Link[];
}

// Fila cruda del segundo fetch: TODOS los vínculos orden↔documento de los docs
// que tocan el período (incluidas órdenes hermanas de otros meses), para poder
// calcular el Δ real de cada documento/pack y no un Δ recortado al mes visible.
interface DocLinkRow {
  tax_document_id: string;
  allocated_amount: number | null;
  match_source: string | null;
  match_score: number | null;
  orders: {
    id: string; order_id: string; order_date: string;
    product_title: string | null; gross_amount: number | null; amount: number;
  } | null;
  tax_documents: Doc | null;
}

const firstDoc = (l: Link): Doc | null =>
  Array.isArray(l.tax_documents) ? (l.tax_documents[0] || null) : l.tax_documents;

type Filter = "attention" | "nodoc" | "delta" | "lowscore" | "clean" | "all";
type NodocReason = "pending_sync" | "no_candidate" | null;

// Una orden que cubre un documento (puede ser de otro mes que el visible).
interface DocOrderRef {
  id: string;
  order_id: string;
  order_date: string;
  product_title: string | null;
  amount: number;      // venta usada para el Δ (allocated_amount si viene, si no gross)
  inPeriod: boolean;
}

// Unidad de conciliación: o un DOCUMENTO (con las N órdenes que cubre), o una
// ORDEN sin documento. El contador revisa por documento, no por orden suelta.
type DocUnit = {
  kind: "doc";
  key: string;
  doc: Doc;
  orders: DocOrderRef[];
  ordersSum: number;
  delta: number;                          // ordersSum − doc.total_amount
  matchSource: string | null;
  matchScore: number | null;
  reason: "delta" | "lowscore" | null;
  outOfPeriodCount: number;
};
type NodocUnit = {
  kind: "nodoc";
  key: string;
  order: OrderRow;
  nodocReason: NodocReason;
};
type Unit = DocUnit | NodocUnit;

export default function PageConciliacion() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [docLinks, setDocLinks] = useState<DocLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("attention");
  const [page, setPage] = useState(0);
  const [maxDocDate, setMaxDocDate] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  // Cuánto avanzó la sincronización de Bsale en general — para distinguir,
  // en las filas "Sin doc", entre "boleta todavía no emitida/sincronizada"
  // (la venta es más nueva que el último documento que tenemos) y "ya
  // tenemos boletas de fechas posteriores y aun así no hay una vinculada"
  // (no es un tema de espera, hay que revisar manualmente).
  useEffect(() => {
    supabase.from("tax_documents").select("document_date")
      .order("document_date", { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setMaxDocDate(data?.document_date ?? null));
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const PAGE = 1000;

      // 1) Órdenes del período (con sus vínculos) — para detectar "sin doc",
      //    los pagos del período y qué documentos aparecen este mes.
      let offset = 0;
      const acc: OrderRow[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("orders")
          .select(`
            id, order_id, order_date, status, product_title, gross_amount, amount,
            net_amount, money_release_date, has_exact_data,
            order_tax_documents (
              match_source, match_score, allocated_amount,
              tax_documents ( id, document_number, document_type, total_amount, external_url )
            )
          `)
          .gte("order_date", from + "T00:00:00")
          .lte("order_date", to + "T23:59:59")
          .neq("status", "cancelled")
          .order("order_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data || []) as unknown as OrderRow[];
        acc.push(...batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      setRows(acc);

      // 2) Para cada documento que toca el período, traer TODAS sus órdenes
      //    vinculadas — también las de otros meses. Sin esto, el Δ de un pack
      //    cuyas órdenes caen en meses distintos sale falso (recortado al mes
      //    visible) y aparece un Δ enorme que en realidad cuadra en $0.
      const docIds = Array.from(new Set(
        acc.flatMap((o) =>
          (o.order_tax_documents || [])
            .map((l) => firstDoc(l)?.id)
            .filter(Boolean) as string[]
        )
      ));
      const links: DocLinkRow[] = [];
      for (let i = 0; i < docIds.length; i += 200) {
        const chunk = docIds.slice(i, i + 200);
        let lo = 0;
        while (true) {
          const { data, error } = await supabase
            .from("order_tax_documents")
            .select(`
              tax_document_id, allocated_amount, match_source, match_score,
              orders ( id, order_id, order_date, product_title, gross_amount, amount ),
              tax_documents ( id, document_number, document_type, total_amount, external_url )
            `)
            .in("tax_document_id", chunk)
            .order("tax_document_id", { ascending: true })
            .range(lo, lo + PAGE - 1);
          if (error) throw error;
          const b = (data || []) as unknown as DocLinkRow[];
          links.push(...b);
          if (b.length < PAGE) break;
          lo += PAGE;
        }
      }
      setDocLinks(links);
    } catch (e) {
      console.error("Error cargando conciliación:", e);
      setRows([]);
      setDocLinks([]);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Acción para filas "Sin doc · no_candidate": ya hay boletas más nuevas
  // sincronizadas y aun así no hubo match — reintenta el mismo matcher
  // automático que usa Pipeline, acotado al período visible.
  const retryReconcile = async () => {
    setRetrying(true);
    try {
      const { from, to } = periodRange(period);
      const { error } = await supabase.functions.invoke("auto-reconcile", {
        body: { date_from: from + "T00:00:00", date_to: to + "T23:59:59" },
      });
      if (error) throw error;
      await fetchRows();
    } catch (e) {
      console.error("Error reintentando conciliación:", e);
    } finally {
      setRetrying(false);
    }
  };

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  // IDs de órdenes que están en el período visible — para marcar, dentro de un
  // documento, qué órdenes son "de este mes" y cuáles vienen de otro.
  const periodOrderIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  // Unidades-documento: una por boleta/factura, con TODAS sus órdenes y el Δ
  // real (suma de todas las ventas vinculadas − total del documento).
  const docUnits = useMemo<DocUnit[]>(() => {
    const m = new Map<string, {
      doc: Doc; orders: DocOrderRef[]; sum: number;
      source: string | null; minScore: number | null;
    }>();
    for (const l of docLinks) {
      const doc = l.tax_documents;
      const ord = l.orders;
      if (!doc || !ord) continue;
      const venta = (l.allocated_amount != null && l.allocated_amount > 0)
        ? l.allocated_amount
        : (ord.gross_amount ?? ord.amount ?? 0);
      const cur = m.get(doc.id) || { doc, orders: [], sum: 0, source: l.match_source, minScore: l.match_score };
      cur.orders.push({
        id: ord.id, order_id: ord.order_id, order_date: ord.order_date,
        product_title: ord.product_title, amount: venta,
        inPeriod: periodOrderIds.has(ord.id),
      });
      cur.sum += venta;
      if (cur.source == null) cur.source = l.match_source;
      if (l.match_score != null) cur.minScore = cur.minScore == null ? l.match_score : Math.min(cur.minScore, l.match_score);
      m.set(doc.id, cur);
    }
    const out: DocUnit[] = [];
    for (const [id, v] of m) {
      const delta = Math.round((v.sum - (v.doc.total_amount || 0)) * 100) / 100;
      let reason: "delta" | "lowscore" | null = null;
      if (Math.abs(delta) > 5) reason = "delta";
      else if (!HARD_SOURCES.has(v.source || "") && v.minScore != null && v.minScore < SCORE_OK) reason = "lowscore";
      out.push({
        kind: "doc", key: "doc:" + id, doc: v.doc,
        orders: v.orders.sort((a, b) => b.amount - a.amount),
        ordersSum: v.sum, delta,
        matchSource: v.source, matchScore: v.minScore, reason,
        outOfPeriodCount: v.orders.filter((o) => !o.inPeriod).length,
      });
    }
    return out;
  }, [docLinks, periodOrderIds]);

  // Unidades sin documento: órdenes del período sin ningún vínculo.
  const nodocUnits = useMemo<NodocUnit[]>(() => {
    return rows
      .filter((o) => (o.order_tax_documents || []).length === 0)
      .map((o) => ({
        kind: "nodoc" as const,
        key: "nodoc:" + o.id,
        order: o,
        nodocReason: (maxDocDate && o.order_date.slice(0, 10) > maxDocDate)
          ? "pending_sync" : "no_candidate" as NodocReason,
      }));
  }, [rows, maxDocDate]);

  const counts = useMemo(() => {
    let delta = 0, lowscore = 0, clean = 0;
    const bySource: Record<string, number> = {};
    for (const d of docUnits) {
      if (d.reason === "delta") delta++;
      else if (d.reason === "lowscore") lowscore++;
      else clean++;
      bySource[d.matchSource || "Manual"] = (bySource[d.matchSource || "Manual"] || 0) + 1;
    }
    const nodoc = nodocUnits.length;
    return {
      total: docUnits.length + nodocUnits.length,
      attention: delta + lowscore + nodoc,
      clean, nodoc, delta, lowscore, bySource,
    };
  }, [docUnits, nodocUnits]);

  // Orden de prioridad en "Requieren atención": sin doc primero (lo más
  // urgente), luego Δ por magnitud, luego score bajo por confianza.
  const attentionUnits = useMemo<Unit[]>(() => {
    const dl = docUnits.filter((d) => d.reason === "delta")
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const ls = docUnits.filter((d) => d.reason === "lowscore")
      .sort((a, b) => (a.matchScore ?? 0) - (b.matchScore ?? 0));
    return [...nodocUnits, ...dl, ...ls];
  }, [nodocUnits, docUnits]);

  const cleanUnits = useMemo<Unit[]>(() => docUnits.filter((d) => d.reason === null), [docUnits]);

  // Plata real de MercadoPago: liberado (ya en mi saldo MP) vs pendiente de liberación.
  const paymentSummary = useMemo(() => {
    const today = new Date();
    let released = 0, releasedCount = 0;
    let pending = 0, pendingCount = 0;
    let noData = 0;
    for (const o of rows) {
      if (!o.has_exact_data) { noData++; continue; }
      const net = o.net_amount || 0;
      if (o.money_release_date && new Date(o.money_release_date) > today) {
        pending += net; pendingCount++;
      } else {
        released += net; releasedCount++;
      }
    }
    return { released, releasedCount, pending, pendingCount, noData };
  }, [rows]);

  // Lista visible según el filtro.
  const visible = useMemo<Unit[]>(() => {
    switch (filter) {
      case "nodoc":    return nodocUnits;
      case "delta":    return docUnits.filter((d) => d.reason === "delta")
                                       .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      case "lowscore": return docUnits.filter((d) => d.reason === "lowscore");
      case "clean":    return cleanUnits;
      case "all":      return [...attentionUnits, ...cleanUnits];
      default:         return attentionUnits; // "attention"
    }
  }, [filter, nodocUnits, docUnits, attentionUnits, cleanUnits]);

  // Paginación client-side: el Δ de los packs necesita todas las órdenes
  // hermanas, así que armamos todo en memoria y paginamos acá.
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => { setPage(0); }, [filter, period]);

  const filters: { key: Filter; label: string }[] = [
    { key: "attention", label: `Requieren atención (${counts.attention})` },
    { key: "nodoc",     label: `Sin documento (${counts.nodoc})` },
    { key: "delta",     label: `Δ ≠ 0 (${counts.delta})` },
    { key: "lowscore",  label: `Confianza baja (${counts.lowscore})` },
    { key: "clean",     label: `Conciliados (${counts.clean})` },
    { key: "all",       label: `Todos (${counts.total})` },
  ];

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">

        {/* Period selector */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold capitalize w-44 text-center">{periodLabel(period)}</h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={fetchRows} disabled={loading}
            className="ml-2 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Resumen / diagnóstico de cómo conciliaron */}
        <div className="bg-white border rounded-lg p-4 mb-6">
          <p className="text-xs text-slate-400 mb-3">
            {counts.attention > 0
              ? <><b className="text-slate-700">{counts.attention}</b> de {counts.total} documentos/ventas requieren atención · {counts.clean} documentos conciliados</>
              : <>✓ Los {counts.total} documentos/ventas del período conciliaron sin excepciones</>}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            {Object.entries(counts.bySource)
              .sort((a, b) => b[1] - a[1])
              .map(([src, n]) => {
                const meta = matchMeta(src);
                return (
                  <span key={src} className={`text-xs px-2 py-1 rounded-md font-medium ${meta.cls}`}>
                    {meta.label}: {n}
                  </span>
                );
              })}
            <span className="text-xs px-2 py-1 rounded-md font-medium bg-red-100 text-red-700">
              Sin documento: {counts.nodoc}
            </span>
          </div>
          {!loading && (counts.bySource["AUTO_HARD_PACK_ID"] || 0) === 0 && (
            <p className="text-xs text-amber-600 mt-3">
              ⚠️ No se conciliaron ventas multiventa (packs) este período. Si vendiste paquetes con varios
              productos en un mismo despacho, revisa que estén llegando — puede faltar sincronizar o haber un
              problema con la conciliación automática.
            </p>
          )}
        </div>

        {/* Plata real de MercadoPago: cuánto me pagaron / cuándo me pagan */}
        <div className="bg-white border rounded-lg p-4 mb-6">
          <p className="text-xs text-slate-400 mb-3">Plata real de MercadoPago en este período</p>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs px-2 py-1 rounded-md font-medium bg-green-100 text-green-700">
              Liberado: {clp(paymentSummary.released)} ({paymentSummary.releasedCount})
            </span>
            <span className="text-xs px-2 py-1 rounded-md font-medium bg-amber-100 text-amber-700">
              Pendiente de liberación: {clp(paymentSummary.pending)} ({paymentSummary.pendingCount})
            </span>
            <span className="text-xs px-2 py-1 rounded-md font-medium bg-slate-100 text-slate-600">
              Sin datos exactos: {paymentSummary.noData}
            </span>
          </div>
          {paymentSummary.noData > 0 && (
            <p className="text-xs text-slate-400 mt-2">
              Corre <b>Sync pagos</b> en{" "}
              <a href="/pipeline" className="text-blue-500 underline">Sincronización</a>{" "}
              para traer los datos exactos de {paymentSummary.noData} órdenes.
            </p>
          )}
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-2 mb-4">
          {filters.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                filter === f.key
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-slate-600 hover:bg-slate-100"
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Tabla */}
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b">
                <th className="px-4 py-2 font-medium">Venta(s)</th>
                <th className="px-4 py-2 font-medium text-right">Monto ventas</th>
                <th className="px-4 py-2 font-medium">Documento</th>
                <th className="px-4 py-2 font-medium text-right">Monto doc</th>
                <th className="px-4 py-2 font-medium">Match</th>
                <th className="px-4 py-2 font-medium text-right">Δ (ventas − doc)</th>
                <th className="px-4 py-2 font-medium">Pago</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  {filter === "attention"
                    ? "✓ Nada requiere atención en este período"
                    : "Sin resultados"}
                </td></tr>
              ) : pageRows.map((u) => {
                if (u.kind === "nodoc") {
                  const o = u.order;
                  const venta = o.gross_amount ?? o.amount;
                  return (
                    <tr key={u.key} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <div className="font-mono text-xs text-slate-500">{o.order_id}</div>
                        <div className="text-slate-700 truncate max-w-[220px]">{o.product_title || "—"}</div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{clp(venta)}</td>
                      <td className="px-4 py-2"><span className="text-slate-300">—</span></td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">—</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700 w-fit">
                            Sin doc
                          </span>
                          {u.nodocReason === "pending_sync" ? (
                            <a href="/pipeline" className="text-[10px] text-blue-500 underline w-fit">
                              Pendiente de sync Bsale
                            </a>
                          ) : (
                            <button
                              onClick={retryReconcile}
                              disabled={retrying}
                              className="text-[10px] text-blue-500 underline w-fit disabled:opacity-40"
                            >
                              {retrying ? "Reintentando..." : "Sin candidato · reintentar"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">—</td>
                      <td className="px-4 py-2">
                        {!o.has_exact_data ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span className="tabular-nums text-slate-700">{clp(o.net_amount)}</span>
                            {o.money_release_date && (() => {
                              const liberado = new Date(o.money_release_date) <= new Date();
                              return (
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium w-fit ${
                                  liberado ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                                }`}>
                                  {liberado ? "Liberado" : "Pendiente"} {format(new Date(o.money_release_date), "dd/MM", { locale: es })}
                                </span>
                              );
                            })()}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                }

                // Unidad documento (1:1 o pack/multiventa).
                const d = u.doc;
                const multi = u.orders.length > 1;
                return (
                  <tr key={u.key} className="border-b last:border-0 hover:bg-slate-50 align-top">
                    <td className="px-4 py-2">
                      <div className="space-y-1">
                        {u.orders.map((o) => (
                          <div key={o.id} className="flex items-center justify-between gap-3">
                            <span className="truncate max-w-[200px] text-slate-700">
                              {o.product_title || o.order_id}
                              {!o.inPeriod && <span className="text-[10px] text-slate-400"> · otro mes</span>}
                            </span>
                            <span className="tabular-nums text-xs text-slate-400 shrink-0">{clp(o.amount)}</span>
                          </div>
                        ))}
                      </div>
                      {multi && (
                        <div className="text-[10px] text-slate-400 mt-1">{u.orders.length} órdenes en este documento</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">{clp(u.ordersSum)}</td>
                    <td className="px-4 py-2">
                      <a href={d.external_url || "#"} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                        {d.document_type} {d.document_number}
                        {d.external_url && <ExternalLink className="h-3 w-3" />}
                      </a>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{clp(d.total_amount)}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${matchMeta(u.matchSource).cls}`}>
                        {matchMeta(u.matchSource).label}{u.matchScore !== null ? ` · ${Math.round(u.matchScore)}%` : ""}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${
                      Math.abs(u.delta) > 5 ? "text-red-600 font-medium" : "text-green-600"
                    }`}>
                      {Math.abs(u.delta) <= 5
                        ? "$0 ✓"
                        : `${u.delta > 0 ? "+" : ""}${clp(u.delta)}`}
                    </td>
                    <td className="px-4 py-2 text-slate-300">—</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {!loading && visible.length > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-slate-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, visible.length)} de {visible.length}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-3">
          Cada fila es un documento (boleta/factura) con las ventas que cubre. En multiventa (pack) un
          documento cubre varias órdenes: el Δ compara la suma de <b>todas</b> sus órdenes — incluidas las
          de otros meses (marcadas «otro mes») — contra el total del documento. Δ ≈ $0 (✓) confirma que
          cuadra en plata. Las ventas sin documento se listan aparte como excepción.
        </p>
      </main>
    </div>
  );
}
