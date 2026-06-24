import { useState, useEffect, useCallback, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, Loader2, Info,
  CheckCircle2, FileText, Package,
} from "lucide-react";
import { chileMonthUnixRange } from "@/lib/chileDate";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";

const PAGE_SIZE = 50;

const CLP = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return { from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"), to: format(new Date(y, m, 0), "yyyy-MM-dd") };
};
const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};
// Fecha corta para liberaciones: "14 jun"
const fmtDay = (d: string | null | undefined) => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : format(dt, "d MMM", { locale: es });
};

const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Créd.",
  nota_debito: "N. Déb.", factura_exenta: "Fact. Ex.",
};
const DOC_COLOR: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700", factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700",
};

const formatRut = (body: string | null) => {
  if (!body) return "—";
  return body.replace(/[^0-9Kk]/g, "") || "—";
};

function detectChannelFromText(text: string | null): string | null {
  if (!text) return null;
  const u = text.toUpperCase();
  if (u.includes('MERCADO LIBRE') || u.includes('MERCADOLIBRE') ||
      u.includes('MERCADO PAGO') || u.includes('MERCADOPAGO')) return 'meli';
  if (u.includes('FALABELLA') || u.includes('CMR')) return 'falabella';
  if (u.includes('PARIS') || u.includes('CENCOSUD')) return 'paris';
  if (u.includes('RIPLEY')) return 'ripley';
  if (u.includes('AMAZON')) return 'amazon';
  if (u.includes('SHOPIFY')) return 'shopify';
  if (u.includes('LINIO')) return 'linio';
  if (u.includes('RAPPI')) return 'rappi';
  if (u.includes('WALMART') || u.includes('LIDER') || u.includes('LÍDER')) return 'walmart';
  return null;
}

function inferChannel(detected: string | null, rawData: any): string | null {
  if (detected) return detected;
  const hit = detectChannelFromText(rawData?.reference_reason)
    ?? detectChannelFromText(rawData?.payment_method_name);
  if (hit) return hit;
  const refs: any[] = rawData?.references?.items ?? [];
  for (const ref of refs) {
    const h = detectChannelFromText(ref.reason) ?? detectChannelFromText(String(ref.number ?? ''));
    if (h) return h;
  }
  return null;
}

const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

// Estado consolidado de liberación de pago para las ventas (orders) de un documento.
// "Liberado" sólo cuando TODAS las ventas tienen dato exacto de MercadoPago
// (has_exact_data=true). "Parcial" cuando algunas sí y otras no — ese es el caso
// que importa al contador: boleta emitida con parte del pago aún sin liberar.
type ReleaseInfo = { state: 'liberado' | 'parcial' | 'pendiente' | 'sin_venta'; label: string; dot: string; text: string };
function releaseInfo(orders: any[] | undefined): ReleaseInfo {
  if (!orders || orders.length === 0)
    return { state: 'sin_venta', label: 'Sin venta asociada', dot: 'bg-slate-300', text: 'text-slate-400' };
  const confirmed = orders.filter(o => o?.has_exact_data === true);
  if (confirmed.length === orders.length) {
    const latest = confirmed.map(o => o.money_release_date).filter(Boolean).sort().pop();
    return { state: 'liberado', label: latest ? `Liberado · ${fmtDay(latest)}` : 'Liberado', dot: 'bg-emerald-500', text: 'text-emerald-600' };
  }
  if (confirmed.length === 0)
    return { state: 'pendiente', label: 'Pendiente', dot: 'bg-slate-300', text: 'text-slate-400' };
  return { state: 'parcial', label: `Parcial · ${confirmed.length} de ${orders.length}`, dot: 'bg-amber-500', text: 'text-amber-600' };
}

// Suma de comisiones reales de las ventas de un documento. allReal=false marca
// que al menos una venta usa comisión estimada (pago aún no liberado).
function commissionOf(orders: any[] | undefined): { total: number; allReal: boolean; hasAny: boolean } {
  if (!orders || orders.length === 0) return { total: 0, allReal: false, hasAny: false };
  const total = orders.reduce((s, o) => s + Math.abs(o?.commission_amount ?? 0), 0);
  const allReal = orders.every(o => o?.has_exact_data === true);
  return { total, allReal, hasAny: true };
}

const FINANCIAL_COLS = "id, order_id, order_date, gross_amount, net_amount, commission_amount, money_release_date, has_exact_data";

export default function PageDocumentos() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [channelFilter, setChannelFilter] = useState<string>("todos");

  const [docs, setDocs] = useState<any[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsMeliCount, setDocsMeliCount] = useState(0);
  const [docsSum, setDocsSum] = useState<number | null>(null);
  const [docsIva, setDocsIva] = useState<number | null>(null);
  const [comisionTotal, setComisionTotal] = useState<number | null>(null);
  const [pendingRelease, setPendingRelease] = useState<number | null>(null);
  const [docFilteredTotal, setDocFilteredTotal] = useState<number | null>(null);
  const [docPage, setDocPage] = useState(0);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docSyncing, setDocSyncing] = useState(false);
  const [docSyncMsg, setDocSyncMsg] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<any | null>(null);
  const [selectedDocSales, setSelectedDocSales] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  useEffect(() => {
    if (!selectedDoc) { setSelectedDocSales(null); return; }
    let cancelled = false;
    setSelectedDocSales(null);
    (async () => {
      const { data: links } = await supabase
        .from("order_tax_documents")
        .select("order_id, allocated_amount, match_source")
        .eq("tax_document_id", selectedDoc.id);
      if (cancelled) return;
      if (!links || links.length === 0) { setSelectedDocSales([]); return; }
      const orderIds = links.map((l: any) => l.order_id);
      const { data: ordersData } = await supabase
        .from("orders")
        .select("id, order_id, order_date, gross_amount, customer_name, product_title, channel, status")
        .in("id", orderIds);
      if (cancelled) return;
      const byId = new Map((ordersData ?? []).map((o: any) => [o.id, o]));
      const sales = links
        .map((l: any) => {
          const o = byId.get(l.order_id);
          if (!o) return null;
          return { ...o, allocated_amount: l.allocated_amount, match_source: l.match_source };
        })
        .filter((s: any) => s !== null);
      setSelectedDocSales(sales);
    })();
    return () => { cancelled = true; };
  }, [selectedDoc]);

  // Trae los datos financieros (venta/comisión/liberación) de las órdenes
  // vinculadas a una página de documentos y los adjunta como _linkedOrders.
  // Se hace en dos pasos (links → orders por id) en vez de un embed anidado,
  // que es el patrón ya probado en este archivo para el panel de detalle.
  const attachOrders = useCallback(async (docsArr: any[]): Promise<any[]> => {
    const ids: string[] = [];
    for (const d of docsArr)
      for (const l of (d.order_tax_documents ?? []))
        if (l.order_id) ids.push(l.order_id);
    if (ids.length === 0) return docsArr.map(d => ({ ...d, _linkedOrders: [] }));
    const ordMap = new Map<string, any>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 300) {
      const { data: ords } = await supabase
        .from("orders").select(FINANCIAL_COLS)
        .in("id", uniq.slice(i, i + 300));
      for (const o of ords ?? []) ordMap.set(o.id, o);
    }
    return docsArr.map(d => ({
      ...d,
      _linkedOrders: (d.order_tax_documents ?? [])
        .map((l: any) => ordMap.get(l.order_id))
        .filter(Boolean),
    }));
  }, []);

  const fetchDocs = useCallback(async (p: number) => {
    setDocsLoading(true);
    try {
      const { from, to } = periodRange(period);

      const [{ count }, { data: sumRows }, { data: ivaRows }] = await Promise.all([
        supabase.from("tax_documents").select("*", { count: "exact", head: true })
          .gte("document_date", from).lte("document_date", to),
        supabase.from("tax_documents").select("total_amount.sum()")
          .gte("document_date", from).lte("document_date", to).eq("status", "issued"),
        supabase.from("tax_documents").select("tax_amount.sum()")
          .gte("document_date", from).lte("document_date", to).eq("status", "issued"),
      ]);
      setDocsTotal(count || 0);
      setDocsSum((sumRows as any)?.[0]?.sum ?? null);
      setDocsIva((ivaRows as any)?.[0]?.sum ?? null);

      // Recorre todos los documentos del período una vez para: (a) contar
      // vinculados a MeLi y (b) juntar los order_id vinculados, con los que
      // luego calculamos comisión total real y liberaciones pendientes.
      const docLinkRows: { order_tax_documents: { order_id: string }[] }[] = [];
      for (let page = 0; page < 20; page++) {
        const { data } = await supabase
          .from("tax_documents")
          .select("order_tax_documents(order_id)")
          .gte("document_date", from).lte("document_date", to)
          .order("document_date", { ascending: false })
          .order("id", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (!data || data.length === 0) break;
        docLinkRows.push(...(data as any));
        if (data.length < 1000) break;
      }
      setDocsMeliCount(docLinkRows.filter(d => (d.order_tax_documents?.length ?? 0) > 0).length);

      const linkedOrderIds = [...new Set(
        docLinkRows.flatMap(d => (d.order_tax_documents ?? []).map(l => l.order_id)).filter(Boolean)
      )];
      let comTotal = 0, pending = 0;
      for (let i = 0; i < linkedOrderIds.length; i += 300) {
        const { data: ords } = await supabase
          .from("orders").select("commission_amount, has_exact_data")
          .in("id", linkedOrderIds.slice(i, i + 300));
        for (const o of (ords ?? []) as any[]) {
          comTotal += Math.abs(o.commission_amount ?? 0);
          if (o.has_exact_data !== true) pending++;
        }
      }
      setComisionTotal(linkedOrderIds.length ? comTotal : null);
      setPendingRelease(pending);

      const FULL_COLS = "id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, detected_channel, status, external_url, raw_data, order_tax_documents(id, order_id)";

      if (channelFilter === "todos") {
        setDocFilteredTotal(null);
        const { data } = await supabase
          .from("tax_documents")
          .select(FULL_COLS)
          .gte("document_date", from).lte("document_date", to)
          .order("document_date", { ascending: false })
          .order("id", { ascending: false })
          .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);
        setDocs(await attachOrders(data || []));
      } else {
        const { data: light } = await (supabase
          .from("tax_documents") as any)
          .select("id, detected_channel, reference_reason:raw_data->>reference_reason, references:raw_data->references")
          .gte("document_date", from).lte("document_date", to)
          .order("document_date", { ascending: false })
          .order("id", { ascending: false });

        const matchedIds = (light || [])
          .filter((d: any) => inferChannel(d.detected_channel, { reference_reason: d.reference_reason, references: d.references }) === channelFilter)
          .map((d: any) => d.id);

        setDocFilteredTotal(matchedIds.length);

        const pageIds = matchedIds.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
        if (pageIds.length === 0) {
          setDocs([]);
        } else {
          const { data: full } = await supabase.from("tax_documents").select(FULL_COLS).in("id", pageIds);
          const byId = new Map((full || []).map((d: any) => [d.id, d]));
          const ordered = pageIds.map((id: string) => byId.get(id)).filter((d: any) => d !== undefined);
          setDocs(await attachOrders(ordered));
        }
      }
    } finally {
      setDocsLoading(false);
    }
  }, [period, channelFilter, attachOrders]);

  useEffect(() => { setDocPage(0); setSelectedDoc(null); setChannelFilter("todos"); setExpanded(new Set()); }, [period]);
  useEffect(() => { setDocPage(0); setSelectedDoc(null); setExpanded(new Set()); }, [channelFilter]);
  useEffect(() => { fetchDocs(docPage); }, [fetchDocs, docPage]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const syncDocs = async () => {
    setDocSyncing(true); setDocSyncMsg("Sincronizando...");
    try {
      const { from: dateFrom, to: dateTo } = chileMonthUnixRange(period);
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { date_from: dateFrom, date_to: dateTo, max_pages: 20 },
      });
      if (error) throw error;
      const tot = data?.summary?.total_upserted ?? 0;
      setDocSyncMsg(`✅ ${tot} documentos`);
      fetchDocs(docPage);
    } catch (e: any) {
      setDocSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally { setDocSyncing(false); }
  };

  const docListTotal  = channelFilter !== "todos" ? (docFilteredTotal ?? 0) : docsTotal;
  const docTotalPages = Math.ceil(docListTotal / PAGE_SIZE);

  const kpis = [
    { label: "Documentos",       value: docsLoading ? "—" : docsTotal.toLocaleString("es-CL"),                 sub: "en el período" },
    { label: "Total facturado",  value: docsLoading || docsSum === null ? "—" : CLP(docsSum),                  sub: "documentos emitidos" },
    { label: "IVA del período",  value: docsLoading || docsIva === null ? "—" : CLP(docsIva),                  sub: "débito fiscal" },
    { label: "Comisiones",       value: docsLoading || comisionTotal === null ? "—" : CLP(comisionTotal),      sub: "real + estimado", color: "text-slate-700" },
    { label: "Vinculados MeLi",  value: docsLoading ? "—" : docsMeliCount,                                     sub: "con venta + pago", color: "text-emerald-600" },
    { label: "Liberación pend.", value: docsLoading || pendingRelease === null ? "—" : pendingRelease,         sub: "ventas sin liberar", color: "text-amber-600" },
  ];

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-slate-400" />
            <h1 className="text-xl font-semibold text-slate-900">Documentos</h1>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-base font-semibold capitalize w-40 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...ALL_CHANNELS].map(ch => (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  channelFilter === ch
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"
                }`}
              >
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-start justify-between mb-4 gap-4">
          <div className="grid grid-cols-6 gap-3 flex-1">
            {kpis.map(({ label, value, sub, color }) => (
              <div key={label} className="bg-white border rounded-lg p-3">
                <p className="text-xs text-slate-400 mb-0.5">{label}</p>
                <p className={`text-xl font-bold ${color || "text-slate-800"}`}>{value}</p>
                <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            {docSyncMsg && <span className={`text-xs ${docSyncMsg.includes("❌") ? "text-red-500" : "text-green-600"}`}>{docSyncMsg}</span>}
            <button onClick={syncDocs} disabled={docSyncing || docsLoading}
              className="flex items-center gap-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm">
              {docSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync Bsale
            </button>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs text-slate-500">
                <th className="text-left px-4 py-3 font-medium">Documento</th>
                <th className="text-left px-4 py-3 font-medium">Fecha doc</th>
                <th className="text-right px-4 py-3 font-medium">Neto</th>
                <th className="text-right px-4 py-3 font-medium">IVA</th>
                <th className="text-right px-4 py-3 font-medium">Total</th>
                <th className="text-left px-4 py-3 font-medium">Ventas</th>
                <th className="text-right px-4 py-3 font-medium">Comisión</th>
                <th className="text-left px-4 py-3 font-medium">Liberación</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {docsLoading ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                </td></tr>
              ) : docs.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-400 text-sm">
                  {channelFilter === "todos"
                    ? "Sin documentos. Prueba Sync Bsale."
                    : `Sin documentos de ${CHANNEL_LABEL[channelFilter] ?? channelFilter} en este período.`}
                </td></tr>
              ) : docs.map(d => {
                const linkedOrders: any[] = d._linkedOrders ?? [];
                const linkCount = linkedOrders.length;
                const isPack = linkCount > 1;
                const isVoided = d.status === "voided";
                const isSelected = selectedDoc?.id === d.id;
                const isOpen = expanded.has(d.id);
                const effectiveChannel = inferChannel(d.detected_channel, d.raw_data);
                const rel = releaseInfo(linkedOrders);
                const com = commissionOf(linkedOrders);

                return (
                  <Fragment key={d.id}>
                    <tr className={`border-b last:border-0 hover:bg-slate-50 ${isVoided ? "opacity-40" : ""} ${isSelected ? "bg-slate-100" : ""}`}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {isPack ? (
                            <button onClick={() => toggleExpand(d.id)} className="text-slate-400 hover:text-slate-600">
                              {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          ) : <span className="w-3.5 inline-block" />}
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${DOC_COLOR[d.document_type] || "bg-slate-100 text-slate-600"}`}>
                            {DOC_LABEL[d.document_type] || d.document_type}
                          </span>
                          <span className="font-mono text-xs text-slate-500">{d.document_number}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 pl-5">
                          <span className="text-[11px] text-slate-400 font-mono">{formatRut(d.client_tax_id)}</span>
                          {d.client_name && <span className="text-[11px] text-slate-400 truncate max-w-[140px]">· {d.client_name}</span>}
                          {effectiveChannel && (
                            <span className={`text-[10px] px-1 py-0 rounded font-medium ${CHANNEL_COLOR[effectiveChannel] || "bg-slate-100 text-slate-500"}`}>
                              {CHANNEL_LABEL[effectiveChannel] || effectiveChannel}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">{d.document_date}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.net_amount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.tax_amount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold">{CLP(d.total_amount)}</td>
                      <td className="px-4 py-2.5">
                        {isVoided ? (
                          <span className="text-xs text-slate-300">Anulado</span>
                        ) : isPack ? (
                          <button onClick={() => toggleExpand(d.id)}
                            className="inline-flex items-center gap-1 text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded text-[11px] font-medium hover:bg-violet-100">
                            <Package className="h-3.5 w-3.5" />Pack · {linkCount} ventas
                          </button>
                        ) : linkCount === 1 ? (
                          <span className="flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="h-3.5 w-3.5" />1 venta</span>
                        ) : (
                          <span className="text-xs text-slate-300">Sin vincular</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        {com.hasAny
                          ? <span className={com.allReal ? "text-slate-700" : "text-slate-400 italic"}>{CLP(com.total)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full ${rel.dot}`} />
                          <span className={rel.text}>{rel.label}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <button onClick={() => setSelectedDoc(isSelected ? null : d)}
                          className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}>
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>

                    {isPack && isOpen && linkedOrders.map((o: any) => {
                      const orel = releaseInfo([o]);
                      return (
                        <tr key={`${d.id}-${o.id}`} className="border-b last:border-0 bg-slate-50/60">
                          <td className="px-4 py-2 pl-14">
                            <span className="text-slate-300 font-mono mr-2">└─</span>
                            <span className="font-mono text-[11px] text-slate-500">venta #{o.order_id}</span>
                            <span className="text-[11px] text-slate-400 ml-2">{o.order_date ? format(new Date(o.order_date), "yyyy-MM-dd") : ""}</span>
                          </td>
                          <td></td>
                          <td></td>
                          <td></td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">{CLP(o.gross_amount)}</td>
                          <td></td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            <span className={o.has_exact_data ? "text-slate-600" : "text-slate-400 italic"}>{CLP(Math.abs(o.commission_amount ?? 0))}</span>
                          </td>
                          <td className="px-4 py-2">
                            <span className="inline-flex items-center gap-1.5 text-xs">
                              <span className={`w-1.5 h-1.5 rounded-full ${orel.dot}`} />
                              <span className={orel.text}>{orel.label}</span>
                            </span>
                          </td>
                          <td></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-400 mt-2">
          Comisión y liberación en <span className="italic text-slate-400">gris cursiva</span> = estimado (pago aún no liberado por MercadoPago). En negro = dato real confirmado.
        </p>

        {docTotalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-slate-400">Página {docPage + 1} de {docTotalPages} · {docListTotal} documentos</span>
            <div className="flex gap-2">
              <button onClick={() => setDocPage(p => Math.max(0, p - 1))} disabled={docPage === 0 || docsLoading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">
                <ChevronLeft className="h-3.5 w-3.5" /> Anterior
              </button>
              <button onClick={() => setDocPage(p => Math.min(docTotalPages - 1, p + 1))} disabled={docPage >= docTotalPages - 1 || docsLoading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">
                Siguiente <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </main>

      {selectedDoc && (
        <DetailPanel
          title={`Bsale · ${DOC_LABEL[selectedDoc.document_type] || selectedDoc.document_type} #${selectedDoc.document_number}`}
          data={selectedDoc}
          linkedSales={selectedDocSales}
          onClose={() => setSelectedDoc(null)}
        />
      )}
    </div>
  );
}
