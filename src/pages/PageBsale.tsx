import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Info, Link2, Clock } from "lucide-react";

const PAGE_SIZE = 50;

const CLP = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};

// Construir la fecha con el constructor local (y, m-1, 1). `new Date("2026-06-01")`
// se parsea como UTC y en husos negativos (Chile, UTC-4) retrocede al mes anterior,
// mostrando "Mayo" cuando las filas son de junio.
const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Crédito",
  nota_debito: "N. Débito", factura_exenta: "Fact. Exenta",
};
const DOC_COLOR: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700", factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700", nota_debito: "bg-orange-100 text-orange-700",
  factura_exenta: "bg-purple-100 text-purple-700",
};
const CHANNEL_LABEL: Record<string, string> = {
  meli: "MercadoLibre", falabella: "Falabella", paris: "Paris",
  ripley: "Ripley", amazon: "Amazon", shopify: "Shopify",
  linio: "Linio", rappi: "Rappi", walmart: "Walmart",
};
const CHANNEL_COLOR: Record<string, string> = {
  meli:      "bg-yellow-100 text-yellow-800",
  shopify:   "bg-blue-100 text-blue-700",
  falabella: "bg-orange-100 text-orange-700",
  paris:     "bg-pink-100 text-pink-700",
  ripley:    "bg-purple-100 text-purple-700",
  amazon:    "bg-amber-100 text-amber-800",
  linio:     "bg-teal-100 text-teal-700",
  rappi:     "bg-rose-100 text-rose-700",
  walmart:   "bg-cyan-100 text-cyan-700",
};

// DB ya guarda solo el cuerpo (sin DV). Mostrar tal cual, solo dígitos.
function formatRut(rut: string | null | undefined): string {
  if (!rut) return "—";
  return rut.replace(/[^0-9]/g, "");
}

export default function PageBsale() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [docs, setDocs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [meliCount, setMeliCount] = useState(0);
  const [monthlyTotal, setMonthlyTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [selected, setSelected] = useState<any | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchDocs = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);

      const [{ count }, { count: meliC }, { data: sumData }] = await Promise.all([
        supabase
          .from("tax_documents")
          .select("*", { count: "exact", head: true })
          .gte("document_date", from).lte("document_date", to),
        // Documentos que corresponden a una venta MELI (inner join a la tabla puente).
        // El resto son de otros canales (tienda física, web) — sin orden ML es lo normal.
        supabase
          .from("tax_documents")
          .select("*, order_tax_documents!inner(id)", { count: "exact", head: true })
          .gte("document_date", from).lte("document_date", to),
        supabase
          .from("tax_documents")
          .select("total_amount.sum()")
          .gte("document_date", from).lte("document_date", to)
          .eq("status", "issued")
          .single(),
      ]);
      setTotal(count || 0);
      setMeliCount(meliC || 0);
      setMonthlyTotal((sumData as any)?.sum ?? null);

      const { data } = await supabase
        .from("tax_documents")
        .select("id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, detected_channel, status, external_url, raw_data, order_tax_documents(id)")
        .gte("document_date", from).lte("document_date", to)
        .order("document_date", { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);

      setDocs(data || []);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { setPage(0); setSelected(null); }, [period]);
  useEffect(() => { fetchDocs(page); }, [fetchDocs, page]);

  const sync = async () => {
    setSyncing(true);
    setSyncMsg("Sincronizando...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { days_back: 90 },
      });
      if (error) throw error;
      const tot = data?.summary?.total_upserted ?? 0;
      const byType = data?.summary?.by_type
        ? Object.entries(data.summary.by_type).map(([k, v]) => `${v} ${k}`).join(" · ")
        : "";
      setSyncMsg(`✅ ${tot} documentos${byType ? ` (${byType})` : ""}`);
      fetchDocs(page);
    } catch (e: any) {
      setSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally {
      setSyncing(false);
    }
  };

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
    setSyncMsg("");
  };

  const otherChannels = Math.max(total - meliCount, 0);
  const totalPages    = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-semibold capitalize w-44 text-center">
              {periodLabel(period)}
            </h1>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            {syncMsg && (
              <span className={`text-sm ${syncMsg.includes("❌") ? "text-red-500" : "text-green-600"}`}>
                {syncMsg}
              </span>
            )}
            <button
              onClick={sync}
              disabled={syncing || loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync Bsale
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: "Documentos",      value: loading ? "—" : total,                                       sub: "en el período" },
            { label: "Total",           value: loading || monthlyTotal === null ? "—" : CLP(monthlyTotal), sub: "facturado mensual" },
            { label: "De ventas MELI",  value: loading ? "—" : meliCount,                                  sub: "vinculados a una orden ML", color: "text-green-600" },
            { label: "De otros canales", value: loading ? "—" : otherChannels,                             sub: "tienda física / web — sin orden ML (normal)",
              color: "text-slate-700" },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color || "text-slate-800"}`}>{value}</p>
              <p className="text-xs text-slate-400 mt-1">{sub}</p>
            </div>
          ))}
        </div>

        {/* Docs table */}
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs text-slate-500">
                <th className="text-left px-4 py-3 font-medium">Tipo</th>
                <th className="text-left px-4 py-3 font-medium">Número</th>
                <th className="text-left px-4 py-3 font-medium">Fecha</th>
                <th className="text-left px-4 py-3 font-medium">Canal</th>
                <th className="text-right px-4 py-3 font-medium">Monto</th>
                <th className="text-left px-4 py-3 font-medium">RUT</th>
                <th className="text-left px-4 py-3 font-medium">Vinculado</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                  </td>
                </tr>
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400 text-sm">
                    Sin documentos. Prueba Sync Bsale.
                  </td>
                </tr>
              ) : docs.map(d => {
                const isLinked   = (d.order_tax_documents as any[])?.length > 0;
                const isVoided   = d.status === "voided";
                const isSelected = selected?.id === d.id;
                return (
                  <tr key={d.id} className={`border-b last:border-0 hover:bg-slate-50 ${isVoided ? "opacity-40" : ""} ${isSelected ? "bg-slate-100" : ""}`}>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${DOC_COLOR[d.document_type] || "bg-slate-100 text-slate-600"}`}>
                        {DOC_LABEL[d.document_type] || d.document_type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{d.document_number}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{d.document_date}</td>
                    <td className="px-4 py-2.5">
                      {d.detected_channel
                        ? <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[d.detected_channel] || "bg-slate-100 text-slate-600"}`}>
                            {CHANNEL_LABEL[d.detected_channel] || d.detected_channel}
                          </span>
                        : <span className="text-xs text-slate-300">—</span>
                      }
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{CLP(d.total_amount)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatRut(d.client_tax_id)}</td>
                    <td className="px-4 py-2.5">
                      {isVoided
                        ? <span className="text-xs text-slate-300">Anulado</span>
                        : isLinked
                          ? <span className="flex items-center gap-1 text-green-600 text-xs"><Link2 className="h-3.5 w-3.5" />Sí</span>
                          : <span className="flex items-center gap-1 text-slate-300 text-xs"><Clock className="h-3.5 w-3.5" />No</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setSelected(isSelected ? null : d)}
                        className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}
                        title="Ver detalle"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-slate-400">
              Página {page + 1} de {totalPages} · {total} documentos
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Anterior
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"
              >
                Siguiente <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

      </main>

      {selected && (
        <DetailPanel
          title={`Bsale · ${DOC_LABEL[selected.document_type] || selected.document_type} #${selected.document_number}`}
          data={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
