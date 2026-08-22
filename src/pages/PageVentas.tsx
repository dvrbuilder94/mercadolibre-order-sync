import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink,
  FileText, Info, Loader2, RefreshCw, ShoppingBag,
} from "lucide-react";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { VentasModuleNav } from "@/components/ventas/VentasModuleNav";
import { supabase } from "@/integrations/supabase/client";
import { CHANNEL_COLOR, CHANNEL_LABEL } from "@/lib/constants";
import { fetchOrderDetail } from "@/lib/orderDetail";
import { chilePeriodNow } from "@/lib/chileDate";

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

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmada", paid: "Pagada", delivered: "Entregada",
  shipped: "Enviada", pending: "Pendiente",
};
const STATUS_COLOR: Record<string, string> = {
  confirmed: "text-emerald-600", paid: "text-emerald-600", delivered: "text-emerald-600",
  shipped: "text-blue-600", pending: "text-amber-500",
};
const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Créd.",
  nota_debito: "N. Déb.", factura_exenta: "Fact. Ex.",
};

const formatRut = (body: string | null) => body ? body.replace(/[^0-9Kk]/g, "") || "—" : "—";
const payLabel = (pm: string | null | undefined) => !pm || pm === "unknown"
  ? "—"
  : pm.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

type SalesResult = {
  rows: any[];
  filtered_total: number;
};

const EMPTY: SalesResult = { rows: [], filtered_total: 0 };

export default function PageVentas() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channelFilter, setChannelFilter] = useState("todos");
  const [docFilter, setDocFilter] = useState<"todos" | "con" | "sin">("todos");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<SalesResult>(EMPTY);
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc("get_ventas_page", {
        p_period: period,
        p_channel: channelFilter,
        p_doc_filter: docFilter,
        p_search: search,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      setResult({
        rows: Array.isArray(data?.rows) ? data.rows : [],
        filtered_total: Number(data?.filtered_total || 0),
      });
    } catch (error) {
      console.error("Error cargando ventas:", error);
      setResult(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [period, channelFilter, docFilter, search, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); setSelectedOrder(null); }, [period, channelFilter, docFilter, search]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
    setChannelFilter("todos");
    setDocFilter("todos");
    setSearchInput("");
  };

  const openDetail = async (id: string) => {
    try { setSelectedOrder(await fetchOrderDetail(id)); } catch { /* optional */ }
  };

  const totalPages = Math.max(1, Math.ceil(result.filtered_total / PAGE_SIZE));

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3">
              <ShoppingBag className="h-5 w-5 text-slate-400" />
              <h1 className="text-2xl font-semibold text-slate-900">Ventas</h1>
            </div>
            <p className="text-sm text-slate-400 mt-1">Detalle operativo de ventas de todos tus canales.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(`/sync?domain=ventas&period=${period}`)} className="flex items-center gap-2 px-3 py-2 bg-white border rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Sync Ventas
            </button>
            <button onClick={() => changePeriod(-1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-medium capitalize w-36 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1.5 hover:bg-slate-100 rounded"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <VentasModuleNav />
          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...ALL_CHANNELS].map((ch) => (
              <button key={ch} onClick={() => setChannelFilter(ch)} className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                channelFilter === ch ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"
              }`}>
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Buscar orden, cliente, producto o RUT" className="flex-1 min-w-[260px] max-w-md px-3 py-2 text-sm border rounded-lg bg-white placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400" />
          <select value={docFilter} onChange={(e) => setDocFilter(e.target.value as any)} className="px-3 py-2 text-sm border rounded-lg bg-white text-slate-600">
            <option value="todos">Toda documentación</option>
            <option value="con">Con documento</option>
            <option value="sin">Sin documento</option>
          </select>
          <span className="ml-auto text-xs text-slate-400">{result.filtered_total.toLocaleString("es-CL")} ventas</span>
        </div>

        <div className="bg-white border rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[1180px]">
            <thead><tr className="border-b bg-slate-50 text-xs text-slate-500">
              <th className="text-left px-3 py-3 font-medium">Canal</th><th className="text-left px-3 py-3 font-medium">Orden</th><th className="text-left px-3 py-3 font-medium">Fecha</th><th className="text-left px-3 py-3 font-medium">Cliente / Producto</th><th className="text-left px-3 py-3 font-medium">RUT</th><th className="text-right px-3 py-3 font-medium">Bruto</th><th className="text-left px-3 py-3 font-medium">Pago</th><th className="text-left px-3 py-3 font-medium">Estado pago</th><th className="text-left px-3 py-3 font-medium">Documento</th><th className="w-8 px-3 py-3" />
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={10} className="text-center py-14 text-slate-400"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando…</td></tr> : result.rows.length === 0 ? <tr><td colSpan={10} className="text-center py-14 text-slate-400">Sin ventas que coincidan con los filtros.</td></tr> : result.rows.map((o) => {
                const doc = o.linked_document;
                return <tr key={o.id} className={`border-b last:border-0 hover:bg-slate-50 ${!o.has_document ? "bg-amber-50/20" : ""}`}>
                  <td className="px-3 py-2.5"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[o.channel] || "bg-slate-100 text-slate-600"}`}>{CHANNEL_LABEL[o.channel] ?? o.channel ?? "—"}</span></td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500 max-w-[120px] truncate" title={o.order_id}>{o.order_id}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">{o.order_date?.slice(0,10)}</td>
                  <td className="px-3 py-2.5 max-w-[190px]"><div className="flex items-center gap-1.5"><span className="truncate text-xs text-slate-800">{o.customer_name || "—"}</span><span className={`text-[10px] shrink-0 ${STATUS_COLOR[o.status] || "text-slate-400"}`}>{STATUS_LABEL[o.status] || o.status}</span></div>{o.product_title && <p className="text-[10px] text-slate-400 truncate mt-0.5">{o.product_title}</p>}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{formatRut(o.customer_tax_id)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{CLP(o.gross_amount)}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{payLabel(o.payment_method)}{o.installments > 1 && <span className="block text-[10px] text-slate-400">{o.installments} cuotas</span>}</td>
                  <td className="px-3 py-2.5">{o.is_stuck ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">Pago sin confirmar</span> : o.has_exact_data ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">Confirmado</span> : <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Pendiente</span>}</td>
                  <td className="px-3 py-2.5">{doc ? (doc.external_url ? <a href={doc.external_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-blue-600 hover:underline text-xs"><FileText className="h-3 w-3" />{DOC_LABEL[doc.document_type] || doc.document_type} {doc.document_number}<ExternalLink className="h-2.5 w-2.5" /></a> : <span className="flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="h-3.5 w-3.5" />{DOC_LABEL[doc.document_type] || doc.document_type} {doc.document_number}</span>) : <span className="flex items-center gap-1 text-amber-600 text-xs font-medium"><AlertCircle className="h-3.5 w-3.5" />Falta</span>}</td>
                  <td className="px-3 py-2.5"><button onClick={() => openDetail(o.id)} className="text-slate-300 hover:text-slate-600"><Info className="h-3.5 w-3.5" /></button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && <div className="flex items-center justify-between mt-3"><span className="text-xs text-slate-400">Página {page + 1} de {totalPages}</span><div className="flex gap-2"><button onClick={() => setPage((p) => Math.max(0,p-1))} disabled={page===0 || loading} className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"><ChevronLeft className="h-3.5 w-3.5" />Anterior</button><button onClick={() => setPage((p) => Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1 || loading} className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">Siguiente<ChevronRight className="h-3.5 w-3.5" /></button></div></div>}
      </main>
      {selectedOrder && <DetailPanel title={`Orden · ${selectedOrder.order_id}`} data={selectedOrder} onClose={() => setSelectedOrder(null)} />}
    </div>
  );
}
