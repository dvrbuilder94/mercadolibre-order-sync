import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Loader2, Search, X } from "lucide-react";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { DocumentosModuleNav } from "@/components/documentos/DocumentosModuleNav";
import { supabase } from "@/integrations/supabase/client";
import { chilePeriodNow } from "@/lib/chileDate";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";

const PAGE_SIZE = 50;
const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

const CLP = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("es-CL", {
    style: "currency", currency: "CLP", maximumFractionDigits: 0,
  }).format(n);

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Créd.",
  nota_debito: "N. Déb.", factura_exenta: "Fact. Ex.",
};
const DOC_COLOR: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700",
  factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700",
};

const fullRut = (d: any) => d?.client_tax_id
  ? `${d.client_tax_id}${d.client_tax_id_dv ? `-${d.client_tax_id_dv}` : ""}`
  : null;
const paymentNames = (d: any): string[] =>
  Array.isArray(d?.raw_data?.payment_method_names) ? d.raw_data.payment_method_names.filter(Boolean) : [];
const referenceReason = (d: any) => d?.raw_data?.reference_reason ?? null;
const referenceItems = (d: any): any[] => Array.isArray(d?.raw_data?.references?.items) ? d.raw_data.references.items : [];
const sourceOrderNumber = (d: any) => d?.external_order_id
  ? String(d.external_order_id)
  : referenceItems(d).find((r: any) => r?.number != null)?.number?.toString() ?? null;

type PagePayload = {
  rows: any[];
  total: number;
  total_amount: number;
  tax_amount: number;
  payment_methods: string[];
};

const EMPTY: PagePayload = { rows: [], total: 0, total_amount: 0, tax_amount: 0, payment_methods: [] };

function normalizePayload(data: any): PagePayload {
  if (!data || typeof data !== "object") return EMPTY;
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    total: Number(data.total || 0),
    total_amount: Number(data.total_amount || 0),
    tax_amount: Number(data.tax_amount || 0),
    payment_methods: Array.isArray(data.payment_methods) ? data.payment_methods.map(String) : [],
  };
}

export default function PageDocumentos() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channelFilter, setChannelFilter] = useState("todos");
  const [typeFilter, setTypeFilter] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [linkFilter, setLinkFilter] = useState("todos");
  const [payFilter, setPayFilter] = useState("todas");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<PagePayload>(EMPTY);
  const [selectedDoc, setSelectedDoc] = useState<any | null>(null);
  const [selectedDocSales, setSelectedDocSales] = useState<any[] | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    setPage(0);
    setSelectedDoc(null);
  }, [period, channelFilter, typeFilter, statusFilter, linkFilter, payFilter, q]);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc("get_documentos_page", {
        p_period: period,
        p_channel: channelFilter,
        p_doc_type: typeFilter,
        p_status: statusFilter,
        p_link_filter: linkFilter,
        p_pay_filter: payFilter,
        p_search: q,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      setPayload(normalizePayload(data));
    } catch (error) {
      console.error("Error cargando documentos:", error);
      setPayload(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [period, channelFilter, typeFilter, statusFilter, linkFilter, payFilter, q, page]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  useEffect(() => {
    if (!selectedDoc) {
      setSelectedDocSales(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: links } = await supabase
        .from("order_tax_documents")
        .select("order_id, allocated_amount, match_source")
        .eq("tax_document_id", selectedDoc.id);
      if (cancelled) return;
      if (!links?.length) return setSelectedDocSales([]);
      const { data: orders } = await supabase
        .from("orders")
        .select("id, order_id, order_date, gross_amount, customer_name, product_title, channel, status")
        .in("id", links.map((l: any) => l.order_id));
      if (cancelled) return;
      const byId = new Map((orders || []).map((o: any) => [o.id, o]));
      setSelectedDocSales(links.map((l: any) => {
        const order = byId.get(l.order_id);
        return order ? { ...order, allocated_amount: l.allocated_amount, match_source: l.match_source } : null;
      }).filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [selectedDoc]);

  const totalPages = Math.max(1, Math.ceil(payload.total / PAGE_SIZE));
  const hasFilters = qInput.trim() || channelFilter !== "todos" || typeFilter !== "todos"
    || statusFilter !== "todos" || linkFilter !== "todos" || payFilter !== "todas";

  const clearFilters = () => {
    setQInput(""); setQ(""); setChannelFilter("todos"); setTypeFilter("todos");
    setStatusFilter("todos"); setLinkFilter("todos"); setPayFilter("todas");
  };

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const kpis = useMemo(() => [
    { label: "Documentos", value: loading ? "—" : payload.total.toLocaleString("es-CL"), sub: "según filtros" },
    { label: "Total documental", value: loading ? "—" : CLP(payload.total_amount), sub: "boletas, facturas y NC" },
    { label: "IVA del período", value: loading ? "—" : CLP(payload.tax_amount), sub: "IVA neto documental" },
  ], [loading, payload]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl min-w-0">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-slate-400" />
              <h1 className="text-2xl font-semibold text-slate-900">Documentos</h1>
            </div>
            <p className="text-sm text-slate-400 mt-1">Listado tributario paginado desde la base de datos.</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded"><ChevronLeft className="h-5 w-5" /></button>
            <span className="text-base font-semibold capitalize w-40 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded"><ChevronRight className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <DocumentosModuleNav />
          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...ALL_CHANNELS].map((ch) => (
              <button key={ch} onClick={() => setChannelFilter(ch)} className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${channelFilter === ch ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"}`}>
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          {kpis.map((k) => <div key={k.label} className="bg-white border rounded-lg p-3"><p className="text-xs text-slate-400">{k.label}</p><p className="text-xl font-bold text-slate-800 mt-0.5">{k.value}</p><p className="text-xs text-slate-400 mt-0.5">{k.sub}</p></div>)}
        </div>

        <div className="bg-white border rounded-lg p-3 mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Nº documento, RUT, orden, referencia…" className="text-xs pl-7 pr-3 py-1.5 border rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-slate-300" />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Todos los tipos</option><option value="boleta">Boleta</option><option value="factura">Factura</option><option value="nota_credito">Nota de crédito</option><option value="nota_debito">Nota de débito</option><option value="factura_exenta">Factura exenta</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Todo estado</option><option value="issued">Vigente</option><option value="voided">Anulado</option>
          </select>
          <select value={linkFilter} onChange={(e) => setLinkFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Toda venta asociada</option><option value="con">Con venta</option><option value="sin">Sin venta</option>
          </select>
          <select value={payFilter} onChange={(e) => setPayFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todas">Toda forma de pago</option>
            {payload.payment_methods.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="__sin__">Sin información</option>
          </select>
          {hasFilters && <button onClick={clearFilters} className="text-xs px-2.5 py-1.5 rounded-md text-slate-500 hover:bg-slate-100 inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> Limpiar</button>}
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400 ml-auto" />}
        </div>

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[1050px]">
            <thead className="bg-slate-50 border-b text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th className="text-left px-3 py-2">Tipo</th><th className="text-left px-3 py-2">Nº documento</th><th className="text-left px-3 py-2">Canal</th><th className="text-left px-3 py-2">Fecha</th><th className="text-right px-3 py-2">Neto</th><th className="text-right px-3 py-2">IVA</th><th className="text-right px-3 py-2">Total</th><th className="text-left px-3 py-2">Pago</th><th className="text-left px-3 py-2">Orden</th><th className="text-left px-3 py-2">Venta</th><th className="text-left px-3 py-2">Link</th></tr>
            </thead>
            <tbody className="divide-y">
              {!loading && payload.rows.length === 0 && <tr><td colSpan={11} className="px-4 py-12 text-center text-sm text-slate-400">No hay documentos para estos filtros.</td></tr>}
              {payload.rows.map((d) => {
                const names = paymentNames(d);
                const ch = d.detected_channel;
                return (
                  <tr key={d.id} onClick={() => setSelectedDoc(d)} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-3 py-2"><span className={`text-xs px-1.5 py-0.5 rounded font-medium ${DOC_COLOR[d.document_type] || "bg-slate-100 text-slate-600"}`}>{DOC_LABEL[d.document_type] || d.document_type}</span></td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{d.document_number || "—"}</td>
                    <td className="px-3 py-2">{ch ? <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-500"}`}>{CHANNEL_LABEL[ch] || ch}</span> : "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{d.document_date || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{CLP(d.net_amount)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{CLP(d.tax_amount)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{CLP(d.total_amount)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{names.length === 0 ? "—" : names.length === 1 ? names[0] : `${names.length} formas`}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{sourceOrderNumber(d) || "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{d.sale_count ? `${d.sale_count} ${d.sale_count === 1 ? "venta" : "ventas"}` : "—"}</td>
                    <td className="px-3 py-2">{d.external_url ? <a href={d.external_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-sky-600 hover:underline inline-flex items-center gap-1">Ver DTE <ExternalLink className="h-3 w-3" /></a> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
          <span>{payload.total.toLocaleString("es-CL")} documentos · página {Math.min(page + 1, totalPages)} de {totalPages}</span>
          <div className="flex gap-2"><button disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))} className="px-3 py-1.5 border rounded disabled:opacity-40">Anterior</button><button disabled={page + 1 >= totalPages || loading} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 border rounded disabled:opacity-40">Siguiente</button></div>
        </div>

        <DetailPanel
          data={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          linkedSales={selectedDocSales}
          title={selectedDoc ? `${DOC_LABEL[selectedDoc.document_type] || selectedDoc.document_type} ${selectedDoc.document_number || ""}` : "Documento"}
        />
      </main>
    </div>
  );
}
