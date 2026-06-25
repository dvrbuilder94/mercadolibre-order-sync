import { useState, useEffect, useCallback, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, Loader2, Info, FileText,
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
type ReleaseInfo = { state: 'liberado' | 'parcial' | 'pendiente' | 'sin_venta' | 'cancelada'; label: string; dot: string; text: string };
function releaseInfo(orders: any[] | undefined, cancelledMatch?: any): ReleaseInfo {
  if (!orders || orders.length === 0) {
    if (cancelledMatch)
      return { state: 'cancelada', label: 'Venta cancelada · revisar NC', dot: 'bg-red-400', text: 'text-red-500' };
    return { state: 'sin_venta', label: 'Sin venta asociada', dot: 'bg-slate-300', text: 'text-slate-400' };
  }
  const confirmed = orders.filter(o => o?.has_exact_data === true);
  if (confirmed.length === orders.length) {
    const latest = confirmed.map(o => o.money_release_date).filter(Boolean).sort().pop();
    return { state: 'liberado', label: latest ? `Liberado · ${fmtDay(latest)}` : 'Liberado', dot: 'bg-emerald-500', text: 'text-emerald-600' };
  }
  if (confirmed.length === 0)
    return { state: 'pendiente', label: 'Pendiente', dot: 'bg-slate-300', text: 'text-slate-400' };
  return { state: 'parcial', label: `Parcial · ${confirmed.length} de ${orders.length}`, dot: 'bg-amber-500', text: 'text-amber-600' };
}

// Dónde quedó la plata liberada. has_exact_data sólo lo marca en true
// sync-meli-payment-details, así que un true real significa que MercadoPago
// confirmó el dato — no inventamos un destino para canales sin esa integración.
function releaseLocation(orders: any[] | undefined): string {
  const rel = releaseInfo(orders);
  if (rel.state === 'liberado') return 'MercadoPago';
  if (rel.state === 'parcial') return 'MercadoPago · parcial';
  return '—';
}

// Suma de comisiones reales de las ventas de un documento. allReal=false marca
// que al menos una venta usa comisión estimada (pago aún no liberado).
function commissionOf(orders: any[] | undefined): { total: number; allReal: boolean; hasAny: boolean } {
  if (!orders || orders.length === 0) return { total: 0, allReal: false, hasAny: false };
  const total = orders.reduce((s, o) => s + Math.abs(o?.commission_amount ?? 0), 0);
  const allReal = orders.every(o => o?.has_exact_data === true);
  return { total, allReal, hasAny: true };
}

const FINANCIAL_COLS = "id, order_id, order_date, gross_amount, net_amount, commission_amount, money_release_date, has_exact_data, status";

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
    const ordMap = new Map<string, any>();
    if (ids.length > 0) {
      const uniq = [...new Set(ids)];
      for (let i = 0; i < uniq.length; i += 300) {
        const { data: ords } = await supabase
          .from("orders").select(FINANCIAL_COLS)
          .in("id", uniq.slice(i, i + 300));
        for (const o of ords ?? []) ordMap.set(o.id, o);
      }
    }
    const withOrders = docsArr.map(d => ({
      ...d,
      _linkedOrders: (d.order_tax_documents ?? [])
        .map((l: any) => ordMap.get(l.order_id))
        .filter(Boolean),
    }));

    // Para documentos sin ninguna venta vinculada, busca si existe una orden
    // cancelada que calce por order_id o pack_id (external_order_id). Distingue
    // "la venta se canceló" (suele necesitar Nota de Crédito) de "nunca se
    // sincronizó nada" — sin esto ambos casos se veían igual ("sin vincular").
    const unlinkedWithRef = withOrders.filter(d => d._linkedOrders.length === 0 && d.external_order_id);
    if (unlinkedWithRef.length > 0) {
      const eois = [...new Set(unlinkedWithRef.map(d => String(d.external_order_id)))];
      const cancelledByKey = new Map<string, any>();
      for (let i = 0; i < eois.length; i += 100) {
        const batch = eois.slice(i, i + 100);
        const orFilter = batch.flatMap(eoi => [`order_id.eq.${eoi}`, `raw_data->>pack_id.eq.${eoi}`]).join(",");
        const { data: cancelled } = await supabase
          .from("orders")
          .select("id, order_id, raw_data, status")
          .eq("status", "cancelled")
          .or(orFilter);
        for (const o of cancelled ?? []) {
          cancelledByKey.set(String(o.order_id), o);
          const packId = (o.raw_data as any)?.pack_id;
          if (packId) cancelledByKey.set(String(packId), o);
        }
      }
      for (const d of withOrders) {
        if (d._linkedOrders.length === 0 && d.external_order_id) {
          const match = cancelledByKey.get(String(d.external_order_id));
          if (match) d._cancelledMatch = match;
        }
      }
    }

    return withOrders;
  }, []);

  const fetchDocs = useCallback(async (p: number) => {
    setDocsLoading(true);
    try {
      const { from, to } = periodRange(period);

      // Trae todos los documentos del período con los campos livianos que
      // hacen falta para: total facturado / IVA del período, conteo de
      // vinculados, filtro por canal y los order_id vinculados (comisión real
      // y liberaciones pendientes). El agregado .sum() de PostgREST no
      // funciona en este proyecto (siempre vuelve null), así que se suma del
      // lado del cliente — y de paso esto deja todos los KPIs consistentes
      // con el filtro de canal activo, en vez de cubrir siempre el período
      // completo sin importar el chip seleccionado.
      const LIGHT_COLS = "id, document_date, total_amount, tax_amount, status, detected_channel, reference_reason:raw_data->>reference_reason, references:raw_data->references, order_tax_documents(order_id, orders(status))";
      const allDocs: any[] = [];
      for (let page = 0; page < 20; page++) {
        const { data } = await (supabase.from("tax_documents") as any)
          .select(LIGHT_COLS)
          .gte("document_date", from).lte("document_date", to)
          .order("document_date", { ascending: false })
          .order("id", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (!data || data.length === 0) break;
        allDocs.push(...data);
        if (data.length < 1000) break;
      }

      const filtered = channelFilter === "todos"
        ? allDocs
        : allDocs.filter(d => inferChannel(d.detected_channel, { reference_reason: d.reference_reason, references: d.references }) === channelFilter);

      setDocsTotal(filtered.length);
      const issued = filtered.filter(d => d.status === "issued");
      setDocsSum(issued.reduce((s, d) => s + (Number(d.total_amount) || 0), 0));
      setDocsIva(issued.reduce((s, d) => s + (Number(d.tax_amount) || 0), 0));
      // Un link a una orden cancelada no cuenta como "venta vinculada": la boleta
      // sigue emitida pero sin venta real detrás (ver Phase 0C/0D de auto-reconcile).
      const isRealLink = (l: any) => l.orders?.status !== 'cancelled';
      setDocsMeliCount(filtered.filter(d => (d.order_tax_documents ?? []).some(isRealLink)).length);

      const linkedOrderIds = [...new Set(
        filtered.flatMap(d => (d.order_tax_documents ?? []).filter(isRealLink).map((l: any) => l.order_id)).filter(Boolean)
      )];
      // Sólo se suma como comisión confirmada la de órdenes con has_exact_data=true;
      // las estimadas no se mezclan en el KPI, sólo se cuentan como pendientes.
      let comReal = 0, pending = 0;
      for (let i = 0; i < linkedOrderIds.length; i += 300) {
        const { data: ords } = await supabase
          .from("orders").select("commission_amount, has_exact_data")
          .in("id", linkedOrderIds.slice(i, i + 300));
        for (const o of (ords ?? []) as any[]) {
          if (o.has_exact_data === true) comReal += Math.abs(o.commission_amount ?? 0);
          else pending++;
        }
      }
      setComisionTotal(linkedOrderIds.length ? comReal : null);
      setPendingRelease(pending);

      const FULL_COLS = "id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, detected_channel, status, external_url, external_order_id, raw_data, order_tax_documents(id, order_id)";
      const pageIds = filtered.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE).map(d => d.id);
      if (pageIds.length === 0) {
        setDocs([]);
      } else {
        const { data: full } = await supabase.from("tax_documents").select(FULL_COLS).in("id", pageIds);
        const byId = new Map((full || []).map((d: any) => [d.id, d]));
        const ordered = pageIds.map((id: string) => byId.get(id)).filter((d: any) => d !== undefined);
        setDocs(await attachOrders(ordered));
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

  const docListTotal  = docsTotal;
  const docTotalPages = Math.ceil(docListTotal / PAGE_SIZE);

  const kpis = [
    { label: "Documentos",          value: docsLoading ? "—" : docsTotal.toLocaleString("es-CL"),             sub: "en el período" },
    { label: "Total facturado",     value: docsLoading || docsSum === null ? "—" : CLP(docsSum),              sub: "documentos emitidos" },
    { label: "IVA del período",     value: docsLoading || docsIva === null ? "—" : CLP(docsIva),               sub: "débito fiscal" },
    { label: "Comisión confirmada", value: docsLoading || comisionTotal === null ? "—" : CLP(comisionTotal),  sub: "cobrada, pago ya liberado", color: "text-slate-700" },
    { label: "Documentos con venta",value: docsLoading ? "—" : docsMeliCount,                                  sub: "con al menos 1 venta vinculada", color: "text-emerald-600" },
    { label: "Liberación pendiente",value: docsLoading || pendingRelease === null ? "—" : pendingRelease,     sub: "ventas con pago aún no liberado", color: "text-amber-600" },
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
                <th className="text-left px-4 py-3 font-medium">Canal</th>
                <th className="text-left px-4 py-3 font-medium">Fecha documento</th>
                <th className="text-right px-4 py-3 font-medium">Monto venta</th>
                <th className="text-right px-4 py-3 font-medium">Comisión</th>
                <th className="text-right px-4 py-3 font-medium">IVA</th>
                <th className="text-right px-4 py-3 font-medium">Total</th>
                <th className="text-left px-4 py-3 font-medium">Ventas</th>
                <th className="text-left px-4 py-3 font-medium">Liberación</th>
                <th className="text-left px-4 py-3 font-medium">Vía de liberación</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {docsLoading ? (
                <tr><td colSpan={11} className="text-center py-12 text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                </td></tr>
              ) : docs.length === 0 ? (
                <tr><td colSpan={11} className="text-center py-12 text-slate-400 text-sm">
                  {channelFilter === "todos"
                    ? "Sin documentos. Prueba Sync Bsale."
                    : `Sin documentos de ${CHANNEL_LABEL[channelFilter] ?? channelFilter} en este período.`}
                </td></tr>
              ) : docs.map(d => {
                const linkedOrders: any[] = d._linkedOrders ?? [];
                // Una orden cancelada vinculada (Phase 0C/0D de auto-reconcile) no es
                // venta real: se separa para que ni el conteo ni la comisión/liberación
                // la mezclen con ventas confirmadas.
                const realOrders = linkedOrders.filter(o => o.status !== "cancelled");
                const cancelledLinked = linkedOrders.filter(o => o.status === "cancelled");
                const cancelledForDisplay = cancelledLinked[0] ?? d._cancelledMatch;
                const linkCount = realOrders.length;
                const isPack = linkedOrders.length > 1;
                const isVoided = d.status === "voided";
                const isSelected = selectedDoc?.id === d.id;
                const isOpen = expanded.has(d.id);
                const effectiveChannel = inferChannel(d.detected_channel, d.raw_data);
                const rel = releaseInfo(realOrders, cancelledForDisplay);
                const com = commissionOf(realOrders);

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
                      </td>
                      <td className="px-4 py-2.5">
                        {effectiveChannel ? (
                          <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[effectiveChannel] || "bg-slate-100 text-slate-500"}`}>
                            {CHANNEL_LABEL[effectiveChannel] || effectiveChannel}
                          </span>
                        ) : <span className="text-xs text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">{d.document_date}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.net_amount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        {com.hasAny
                          ? <span className={com.allReal ? "text-slate-700" : "text-slate-400 italic"}>{CLP(com.total)}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.tax_amount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold">{CLP(d.total_amount)}</td>
                      <td className="px-4 py-2.5">
                        {isVoided ? (
                          <span className="text-xs text-slate-300">Anulado</span>
                        ) : linkCount > 0 ? (
                          <span className="text-xs text-slate-600">{linkCount} {linkCount === 1 ? "venta" : "ventas"}</span>
                        ) : cancelledForDisplay ? (
                          <span className="text-xs text-red-500 font-medium">Venta cancelada</span>
                        ) : (
                          <span className="text-xs text-slate-300">Sin vincular</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full ${rel.dot}`} />
                          <span className={rel.text}>{rel.label}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">{releaseLocation(realOrders)}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={() => setSelectedDoc(isSelected ? null : d)}
                          className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}>
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>

                    {isPack && isOpen && linkedOrders.map((o: any) => {
                      const oCancelled = o.status === "cancelled";
                      const orel = oCancelled
                        ? { dot: 'bg-red-400', text: 'text-red-500', label: 'Cancelada · revisar NC' }
                        : releaseInfo([o]);
                      return (
                        <tr key={`${d.id}-${o.id}`} className="border-b last:border-0 bg-slate-50/60">
                          <td className="px-4 py-2 pl-14">
                            <span className="text-slate-300 font-mono mr-2">└─</span>
                            <span className={`font-mono text-[11px] ${oCancelled ? "text-red-500 line-through" : "text-slate-500"}`}>venta #{o.order_id}</span>
                            <span className="text-[11px] text-slate-400 ml-2">{o.order_date ? format(new Date(o.order_date), "yyyy-MM-dd") : ""}</span>
                          </td>
                          <td></td>
                          <td></td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">{CLP(o.gross_amount)}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {oCancelled ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <span className={o.has_exact_data ? "text-slate-600" : "text-slate-400 italic"}>{CLP(Math.abs(o.commission_amount ?? 0))}</span>
                            )}
                          </td>
                          <td></td>
                          <td></td>
                          <td></td>
                          <td className="px-4 py-2">
                            <span className="inline-flex items-center gap-1.5 text-xs">
                              <span className={`w-1.5 h-1.5 rounded-full ${orel.dot}`} />
                              <span className={orel.text}>{orel.label}</span>
                            </span>
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500">{oCancelled ? "—" : releaseLocation([o])}</td>
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
