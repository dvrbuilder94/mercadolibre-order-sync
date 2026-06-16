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

// match_source → etiqueta + estilo. Es la clave del diagnóstico:
// si "Pack" aparece en 0, el match por pack_id no está corriendo en producción.
const MATCH_META: Record<string, { label: string; cls: string }> = {
  AUTO_HARD_ORDER_ID:      { label: "Exacta",      cls: "bg-green-100 text-green-700" },
  AUTO_HARD_PACK_ID:       { label: "Pack",        cls: "bg-blue-100 text-blue-700" },
  AUTO_CONSOLIDATED:       { label: "Consolidada", cls: "bg-indigo-100 text-indigo-700" },
  AUTO:                    { label: "Score",       cls: "bg-amber-100 text-amber-700" },
  AUTO_SOFT:               { label: "Score bajo",  cls: "bg-amber-100 text-amber-700" },
  AUTO_TIE_BREAK:          { label: "Desempate",   cls: "bg-amber-100 text-amber-700" },
  webhook_external_order_id: { label: "Webhook",   cls: "bg-slate-100 text-slate-600" },
  webhook_fallback_boleta:   { label: "Webhook",   cls: "bg-slate-100 text-slate-600" },
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

const firstDoc = (l: Link): Doc | null =>
  Array.isArray(l.tax_documents) ? (l.tax_documents[0] || null) : l.tax_documents;

type Filter = "attention" | "nodoc" | "delta" | "lowscore" | "clean" | "all";
type Reason = "nodoc" | "delta" | "lowscore" | null;
interface Classified {
  o: OrderRow; l: Link | null; d: Doc | null;
  dd: number | null; score: number | null; reason: Reason;
}

export default function PageConciliacion() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("attention");
  const [page, setPage] = useState(0);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      // Paginado: Supabase corta en 1000 filas por request, así que traemos
      // en páginas hasta agotar (un período puede tener >1000 órdenes).
      const PAGE = 1000;
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
    } catch (e) {
      console.error("Error cargando conciliación:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  // Δ a nivel documento: suma de las ventas vinculadas a cada doc vs total del doc.
  // Usa allocated_amount cuando viene poblado; si no (los matches AUTO_HARD lo
  // dejan en 0/null), cae al monto bruto de la orden. Así un match 1:1 cuadra en
  // $0 y un pack (1 doc ↔ N órdenes) también, sin pintar Δ falsos.
  const docAlloc = useMemo(() => {
    const m = new Map<string, { total: number; alloc: number }>();
    for (const o of rows) {
      const venta = o.gross_amount ?? o.amount ?? 0;
      for (const l of o.order_tax_documents || []) {
        const d = firstDoc(l);
        if (!d) continue;
        const cur = m.get(d.id) || { total: d.total_amount || 0, alloc: 0 };
        cur.alloc += (l.allocated_amount != null && l.allocated_amount > 0)
          ? l.allocated_amount
          : venta;
        m.set(d.id, cur);
      }
    }
    return m;
  }, [rows]);

  // Δ (venta − doc): suma de ventas asignadas al doc menos el total del doc.
  // Positivo = las ventas superan al documento; negativo = el doc es mayor.
  const docDelta = (d: Doc | null): number | null => {
    if (!d) return null;
    const a = docAlloc.get(d.id);
    if (!a) return null;
    return Math.round((a.alloc - a.total) * 100) / 100;
  };

  // Clasificación por fila: ¿requiere atención (sin doc / Δ≠0 / score bajo) o
  // concilió limpio? Un workbench de conciliación es una bandeja de excepciones,
  // no un libro mayor: lo que cuadra solo se colapsa, lo dudoso sube.
  const classified = useMemo<Classified[]>(() => {
    return rows.map((o) => {
      const links = o.order_tax_documents || [];
      const l = links[0] || null;
      const d = l ? firstDoc(l) : null;
      const dd = docDelta(d);
      const score = l?.match_score ?? null;
      let reason: Reason = null;
      if (links.length === 0) reason = "nodoc";
      else if (dd !== null && Math.abs(dd) > 1) reason = "delta";
      else if (l && !HARD_SOURCES.has(l.match_source || "") && score !== null && score < SCORE_OK) reason = "lowscore";
      return { o, l, d, dd, score, reason };
    });
  }, [rows, docAlloc]);

  const counts = useMemo(() => {
    const c = { total: classified.length, attention: 0, clean: 0, nodoc: 0, delta: 0, lowscore: 0, bySource: {} as Record<string, number> };
    for (const x of classified) {
      if (x.reason) { c.attention++; (c as any)[x.reason]++; }
      else c.clean++;
      if (x.l) c.bySource[x.l.match_source || "Manual"] = (c.bySource[x.l.match_source || "Manual"] || 0) + 1;
    }
    return c;
  }, [classified]);

  const REASON_RANK: Record<string, number> = { nodoc: 0, delta: 1, lowscore: 2 };
  const attentionRows = useMemo(() => {
    return classified
      .filter((c) => c.reason !== null)
      .sort((a, b) => {
        const ra = REASON_RANK[a.reason!] - REASON_RANK[b.reason!];
        if (ra !== 0) return ra;
        if (a.reason === "delta") return Math.abs(b.dd!) - Math.abs(a.dd!);
        if (a.reason === "lowscore") return (a.score ?? 0) - (b.score ?? 0);
        return 0;
      });
  }, [classified]);

  const cleanRows = useMemo(() => classified.filter((c) => c.reason === null), [classified]);

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
  const visible = useMemo(() => {
    switch (filter) {
      case "nodoc":    return attentionRows.filter((c) => c.reason === "nodoc");
      case "delta":    return attentionRows.filter((c) => c.reason === "delta");
      case "lowscore": return attentionRows.filter((c) => c.reason === "lowscore");
      case "clean":    return cleanRows;
      case "all":      return classified;
      default:         return attentionRows; // "attention"
    }
  }, [filter, attentionRows, cleanRows, classified]);

  // Paginación client-side: ya tenemos todo el período en memoria (el Δ de los
  // packs necesita todas las filas hermanas, por eso no se pagina en el servidor).
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => { setPage(0); }, [filter, period]);

  const filters: { key: Filter; label: string; tone?: string }[] = [
    { key: "attention", label: `Requieren atención (${counts.attention})` },
    { key: "nodoc",     label: `Sin documento (${counts.nodoc})` },
    { key: "delta",     label: `Δ ≠ 0 (${counts.delta})` },
    { key: "lowscore",  label: `Score bajo (${counts.lowscore})` },
    { key: "clean",     label: `Conciliadas (${counts.clean})` },
    { key: "all",       label: `Todas (${counts.total})` },
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

        {/* Resumen / diagnóstico de cómo machearon */}
        <div className="bg-white border rounded-lg p-4 mb-6">
          <p className="text-xs text-slate-400 mb-3">
            {counts.attention > 0
              ? <><b className="text-slate-700">{counts.attention}</b> de {counts.total} ventas requieren atención · {counts.clean} conciliadas automáticamente</>
              : <>✓ Las {counts.total} ventas del período conciliaron sin excepciones</>}
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
              ⚠️ No hay matches por <b>Pack</b>. Si tienes ventas multiventa, el match por <code>pack_id</code> no
              está corriendo en producción (función desplegada desactualizada o falta data).
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
                <th className="px-4 py-2 font-medium">Venta</th>
                <th className="px-4 py-2 font-medium text-right">Monto venta</th>
                <th className="px-4 py-2 font-medium">Documento</th>
                <th className="px-4 py-2 font-medium text-right">Monto doc</th>
                <th className="px-4 py-2 font-medium">Match</th>
                <th className="px-4 py-2 font-medium text-right">Δ (venta − doc)</th>
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
              ) : pageRows.map(({ o, l, d, dd, score }) => {
                const venta = o.gross_amount ?? o.amount;
                return (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-slate-500">{o.order_id}</div>
                      <div className="text-slate-700 truncate max-w-[220px]">{o.product_title || "—"}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{clp(venta)}</td>
                    <td className="px-4 py-2">
                      {d ? (
                        <a href={d.external_url || "#"} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                          {d.document_type} {d.document_number}
                          {d.external_url && <ExternalLink className="h-3 w-3" />}
                        </a>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                      {d ? clp(d.total_amount) : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {l ? (
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${matchMeta(l.match_source).cls}`}>
                          {matchMeta(l.match_source).label}{score !== null ? ` · ${Math.round(score)}%` : ""}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700">
                          Sin doc
                        </span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${
                      dd === null ? "text-slate-300"
                        : Math.abs(dd) > 1 ? "text-red-600 font-medium"
                        : "text-green-600"
                    }`}>
                      {dd === null
                        ? "—"
                        : Math.abs(dd) <= 1
                          ? "$0 ✓"
                          : `${dd > 0 ? "+" : ""}${clp(dd)}`}
                    </td>
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
          Δ (venta − doc) = suma de las ventas vinculadas al documento − total del documento. En multiventa
          (pack) un documento cubre varias ventas, así que se compara contra la suma de todas; Δ ≈ $0 (✓)
          confirma que el match cuadra en plata. Sin documento se muestra «—».
        </p>
      </main>
    </div>
  );
}
