import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, ExternalLink, Loader2 } from "lucide-react";

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
  order_tax_documents: Link[];
}

const firstDoc = (l: Link): Doc | null =>
  Array.isArray(l.tax_documents) ? (l.tax_documents[0] || null) : l.tax_documents;

type Filter = "all" | "nodoc" | "pack" | "exact" | "delta";

export default function PageConciliacion() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const { data, error } = await supabase
        .from("orders")
        .select(`
          id, order_id, order_date, status, product_title, gross_amount, amount,
          order_tax_documents (
            match_source, match_score, allocated_amount,
            tax_documents ( id, document_number, document_type, total_amount, external_url )
          )
        `)
        .gte("order_date", from + "T00:00:00")
        .lte("order_date", to + "T23:59:59")
        .neq("status", "cancelled")
        .order("order_date", { ascending: false })
        .limit(2000);
      if (error) throw error;
      setRows((data || []) as unknown as OrderRow[]);
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

  // Δ a nivel documento: suma de lo asignado a cada doc vs total del doc.
  const docAlloc = useMemo(() => {
    const m = new Map<string, { total: number; alloc: number }>();
    for (const o of rows) {
      for (const l of o.order_tax_documents || []) {
        const d = firstDoc(l);
        if (!d) continue;
        const cur = m.get(d.id) || { total: d.total_amount || 0, alloc: 0 };
        cur.alloc += l.allocated_amount || 0;
        m.set(d.id, cur);
      }
    }
    return m;
  }, [rows]);

  const docDelta = (d: Doc | null): number | null => {
    if (!d) return null;
    const a = docAlloc.get(d.id);
    if (!a) return null;
    return Math.round((a.total - a.alloc) * 100) / 100;
  };

  // Resumen / diagnóstico
  const summary = useMemo(() => {
    const bySource: Record<string, number> = {};
    let linked = 0, nodoc = 0;
    for (const o of rows) {
      const links = o.order_tax_documents || [];
      if (links.length === 0) { nodoc++; continue; }
      linked++;
      const src = links[0].match_source || "Manual";
      bySource[src] = (bySource[src] || 0) + 1;
    }
    return { total: rows.length, linked, nodoc, bySource };
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((o) => {
      const links = o.order_tax_documents || [];
      const l = links[0];
      const d = l ? firstDoc(l) : null;
      switch (filter) {
        case "nodoc": return links.length === 0;
        case "pack":  return l?.match_source === "AUTO_HARD_PACK_ID";
        case "exact": return l?.match_source === "AUTO_HARD_ORDER_ID";
        case "delta": { const dd = docDelta(d); return dd !== null && Math.abs(dd) > 1; }
        default:      return true;
      }
    });
  }, [rows, filter, docAlloc]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all",   label: `Todas (${summary.total})` },
    { key: "nodoc", label: `Sin documento (${summary.nodoc})` },
    { key: "pack",  label: `Por pack (${summary.bySource["AUTO_HARD_PACK_ID"] || 0})` },
    { key: "exact", label: `Exactas (${summary.bySource["AUTO_HARD_ORDER_ID"] || 0})` },
    { key: "delta", label: "Δ monto ≠ 0" },
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
          <p className="text-xs text-slate-400 mb-3">Cómo conciliaron las {summary.total} ventas del período</p>
          <div className="flex flex-wrap gap-2 items-center">
            {Object.entries(summary.bySource)
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
              Sin documento: {summary.nodoc}
            </span>
          </div>
          {!loading && (summary.bySource["AUTO_HARD_PACK_ID"] || 0) === 0 && (
            <p className="text-xs text-amber-600 mt-3">
              ⚠️ No hay matches por <b>Pack</b>. Si tienes ventas multiventa, el match por <code>pack_id</code> no
              está corriendo en producción (función desplegada desactualizada o falta data).
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
                <th className="px-4 py-2 font-medium text-right">Δ doc</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Sin resultados</td></tr>
              ) : filtered.map((o) => {
                const l = (o.order_tax_documents || [])[0];
                const d = l ? firstDoc(l) : null;
                const dd = docDelta(d);
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
                          {matchMeta(l.match_source).label}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700">
                          Sin doc
                        </span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${
                      dd !== null && Math.abs(dd) > 1 ? "text-red-600 font-medium" : "text-slate-400"
                    }`}>
                      {dd === null ? "—" : dd === 0 ? "$0" : clp(dd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-400 mt-3">
          Δ doc = total del documento − suma asignada a sus órdenes. En multiventa (pack) un documento cubre
          varias ventas; Δ ≈ $0 confirma que el match cuadra en plata.
        </p>
      </main>
    </div>
  );
}
