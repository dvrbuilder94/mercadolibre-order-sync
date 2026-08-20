import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Info, FileText, Search, SlidersHorizontal, ExternalLink, X } from "lucide-react";
import { chileMonthDateRange, chileMonthUnixRange, chilePeriodNow } from "@/lib/chileDate";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";
import { signedTaxDocumentAmount } from "@/lib/financialRules";

const PAGE_SIZE = 50;
const COLS_KEY = "documentos.listado.columns.v3";

type ColKey =
  | "tipo" | "numero" | "canal" | "fecha" | "neto" | "iva" | "total" | "pago"
  | "rut" | "orden" | "referencia" | "estado" | "venta" | "link";

const COLUMNS: { key: ColKey; label: string; align?: "right"; fixed?: boolean }[] = [
  { key: "tipo", label: "Tipo", fixed: true },
  { key: "numero", label: "Nº documento", fixed: true },
  { key: "canal", label: "Canal" },
  { key: "fecha", label: "Fecha" },
  { key: "neto", label: "Neto", align: "right" },
  { key: "iva", label: "IVA", align: "right" },
  { key: "total", label: "Total", align: "right" },
  { key: "pago", label: "Forma de pago" },
  { key: "rut", label: "RUT" },
  { key: "orden", label: "Orden de compra / externa" },
  { key: "referencia", label: "Referencia/origen" },
  { key: "estado", label: "Estado" },
  { key: "venta", label: "Venta asociada" },
  { key: "link", label: "Link" },
];

const DEFAULT_COLS: ColKey[] = ["tipo", "numero", "canal", "fecha", "neto", "iva", "total", "pago", "orden", "venta", "link"];

/** Formas de pago reales vienen de Bsale `payments` → `payment_type`.
 * `coin.name` ("Peso Chileno") NO es forma de pago y no se usa aquí. */
function paymentNames(d: any): string[] {
  const arr = d?.payment_method_names;
  return Array.isArray(arr) ? arr.filter(Boolean) : [];
}

const fullRut = (d: any) =>
  d?.client_tax_id ? `${d.client_tax_id}${d.client_tax_id_dv ? `-${d.client_tax_id_dv}` : ""}` : null;

const CLP = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(n);

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta",
  factura: "Factura",
  nota_credito: "N. Créd.",
  nota_debito: "N. Déb.",
  factura_exenta: "Fact. Ex.",
};

const DOC_COLOR: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700",
  factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700",
};

function detectChannelFromText(text: string | null): string | null {
  if (!text) return null;
  const u = text.toUpperCase();
  if (u.includes("MERCADO LIBRE") || u.includes("MERCADOLIBRE") || u.includes("MERCADO PAGO") || u.includes("MERCADOPAGO")) return "meli";
  if (u.includes("FALABELLA") || u.includes("CMR")) return "falabella";
  if (u.includes("PARIS") || u.includes("CENCOSUD")) return "paris";
  if (u.includes("RIPLEY")) return "ripley";
  if (u.includes("AMAZON")) return "amazon";
  if (u.includes("SHOPIFY")) return "shopify";
  if (u.includes("LINIO")) return "linio";
  if (u.includes("RAPPI")) return "rappi";
  if (u.includes("WALMART") || u.includes("LIDER") || u.includes("LÍDER")) return "walmart";
  return null;
}

function referenceItems(d: any): any[] {
  const items = d?.raw_data?.references?.items ?? d?.references?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function referenceReason(d: any): string | null {
  return d?.raw_data?.reference_reason ?? d?.reference_reason ?? null;
}

function inferChannel(detected: string | null, rawData: any): string | null {
  if (detected) return detected;
  const hit = detectChannelFromText(rawData?.reference_reason);
  if (hit) return hit;
  const refs: any[] = rawData?.references?.items ?? [];
  for (const ref of refs) {
    const h = detectChannelFromText(ref.reason) ?? detectChannelFromText(String(ref.number ?? ""));
    if (h) return h;
  }
  return null;
}

/** Orden externa/OC de la fuente. Prioriza el ID explícito guardado por Quadra.
 * Si no existe (caso frecuente Shopify), usa una referencia Bsale cuyo motivo
 * identifica al mismo canal. Nunca usa document_number: ese es el folio DTE. */
function sourceOrderNumber(d: any): string | null {
  if (d?.external_order_id) return String(d.external_order_id);
  const refs = referenceItems(d);
  const channel = inferChannel(d?.detected_channel ?? null, {
    reference_reason: referenceReason(d),
    references: { items: refs },
  });
  const sourceRef = refs.find((ref: any) =>
    ref?.number != null && channel && detectChannelFromText(ref?.reason ?? null) === channel
  );
  return sourceRef?.number != null ? String(sourceRef.number) : null;
}

const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

function renderCell(d: any, key: ColKey) {
  switch (key) {
    case "tipo":
      return (
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${DOC_COLOR[d.document_type] || "bg-slate-100 text-slate-600"}`}>{DOC_LABEL[d.document_type] || d.document_type}</span>
      );
    case "numero":
      return <span className="font-mono text-xs text-slate-600">{d.document_number || "—"}</span>;
    case "canal": {
      const ch = inferChannel(d.detected_channel, {
        reference_reason: referenceReason(d),
        references: { items: referenceItems(d) },
      });
      return ch
        ? <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-500"}`}>{CHANNEL_LABEL[ch] || ch}</span>
        : <span className="text-xs text-slate-300">—</span>;
    }
    case "fecha":
      return <span className="text-xs text-slate-500">{d.document_date}</span>;
    case "neto":
      return <span className="font-mono text-xs text-slate-600">{CLP(d.net_amount)}</span>;
    case "iva":
      return <span className="font-mono text-xs text-slate-600">{CLP(d.tax_amount)}</span>;
    case "total":
      return <span className="font-mono text-xs font-semibold">{CLP(d.total_amount)}</span>;
    case "pago": {
      const names = paymentNames(d.raw_data ?? d);
      if (names.length === 0) return <span className="text-xs text-slate-300">—</span>;
      if (names.length === 1) return <span className="text-xs text-slate-600">{names[0]}</span>;
      return <span className="text-xs text-slate-600" title={names.join(" + ")}>{names.length} formas</span>;
    }
    case "rut":
      return <span className="font-mono text-xs text-slate-500">{fullRut(d) || "—"}</span>;
    case "orden": {
      const orderNumber = sourceOrderNumber(d);
      return <span className="font-mono text-xs text-slate-500">{orderNumber || "—"}</span>;
    }
    case "referencia":
      return <span className="text-xs text-slate-500">{referenceReason(d) || "—"}</span>;
    case "estado":
      return d.status === "voided"
        ? <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-700">Anulado</span>
        : <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700">Vigente</span>;
    case "venta": {
      const links = d.order_tax_documents || [];
      return <span className="text-xs text-slate-500">{links.length ? `${links.length} ${links.length === 1 ? "venta" : "ventas"}` : "—"}</span>;
    }
    case "link":
      return d.external_url
        ? <a href={d.external_url} target="_blank" rel="noopener noreferrer" className="text-xs text-sky-600 hover:underline inline-flex items-center gap-1">Ver DTE <ExternalLink className="h-3 w-3" /></a>
        : <span className="text-xs text-slate-300">—</span>;
    default:
      return null;
  }
}

export default function PageDocumentos() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channelFilter, setChannelFilter] = useState("todos");
  const [allDocs, setAllDocs] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsSum, setDocsSum] = useState<number | null>(null);
  const [docsIva, setDocsIva] = useState<number | null>(null);
  const [docPage, setDocPage] = useState(0);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docSyncing, setDocSyncing] = useState(false);
  const [docSyncMsg, setDocSyncMsg] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<any | null>(null);
  const [selectedDocSales, setSelectedDocSales] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [linkFilter, setLinkFilter] = useState("todos");
  const [payFilter, setPayFilter] = useState("todas");
  const [colsOpen, setColsOpen] = useState(false);
  const [visible, setVisible] = useState<Set<ColKey>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return new Set(saved as ColKey[]);
    } catch { /* ignore */ }
    return new Set(DEFAULT_COLS);
  });

  useEffect(() => {
    localStorage.setItem(COLS_KEY, JSON.stringify(Array.from(visible)));
  }, [visible]);

  const shownCols = COLUMNS.filter((c) => c.fixed || visible.has(c.key));
  const toggleCol = (key: ColKey) =>
    setVisible((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

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
      if (!links?.length) {
        setSelectedDocSales([]);
        return;
      }
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

  const fetchDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const { from, to } = chileMonthDateRange(period);
      const LIGHT_COLS = "id, document_number, document_type, document_date, net_amount, total_amount, tax_amount, status, detected_channel, client_name, client_tax_id, client_tax_id_dv, external_order_id, external_url, reference_reason:raw_data->>reference_reason, references:raw_data->references, payment_method_names:raw_data->payment_method_names, order_tax_documents(id, order_id)";
      const loadedDocs: any[] = [];

      for (let i = 0; i < 20; i++) {
        const { data, error } = await (supabase.from("tax_documents") as any)
          .select(LIGHT_COLS)
          .gte("document_date", from)
          .lte("document_date", to)
          .order("document_date", { ascending: false })
          .order("id", { ascending: true })
          .range(i * 1000, i * 1000 + 999);
        if (error) throw error;
        if (!data?.length) break;
        loadedDocs.push(...data);
        if (data.length < 1000) break;
      }

      setAllDocs(loadedDocs);
    } catch (error) {
      console.error("Error cargando documentos:", error);
      setAllDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [period]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return allDocs.filter((d) => {
      const channel = inferChannel(d.detected_channel, {
        reference_reason: referenceReason(d),
        references: { items: referenceItems(d) },
      });
      if (channelFilter !== "todos" && channel !== channelFilter) return false;
      if (typeFilter !== "todos" && d.document_type !== typeFilter) return false;
      if (statusFilter !== "todos") {
        const voided = d.status === "voided";
        if (statusFilter === "voided" ? !voided : voided) return false;
      }
      const hasSale = (d.order_tax_documents?.length ?? 0) > 0;
      if (linkFilter === "con" && !hasSale) return false;
      if (linkFilter === "sin" && hasSale) return false;
      if (payFilter !== "todas") {
        const names = paymentNames(d);
        if (payFilter === "__sin__" ? names.length > 0 : !names.includes(payFilter)) return false;
      }
      if (term) {
        const hay = [
          d.document_number,
          fullRut(d),
          d.client_tax_id,
          sourceOrderNumber(d),
          referenceReason(d),
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [allDocs, q, channelFilter, typeFilter, statusFilter, linkFilter, payFilter]);

  const payOptions = useMemo(() => {
    const s = new Set<string>();
    allDocs.forEach((d) => paymentNames(d).forEach((n) => s.add(n)));
    return Array.from(s).sort();
  }, [allDocs]);

  useEffect(() => {
    setDocsTotal(filtered.length);
    const issued = filtered.filter((d) => d.status === "issued");
    setDocsSum(issued.reduce((sum, d) => sum + signedTaxDocumentAmount(d.document_type, d.total_amount), 0));
    setDocsIva(issued.reduce((sum, d) => sum + signedTaxDocumentAmount(d.document_type, d.tax_amount), 0));
  }, [filtered]);

  useEffect(() => {
    let cancelled = false;
    const pageIds = filtered.slice(docPage * PAGE_SIZE, docPage * PAGE_SIZE + PAGE_SIZE).map((d) => d.id);
    if (!pageIds.length) { setDocs([]); return; }
    (async () => {
      const FULL_COLS = "id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, client_tax_id_dv, detected_channel, status, external_url, external_order_id, raw_data, order_tax_documents(id, order_id)";
      const { data: full } = await supabase.from("tax_documents").select(FULL_COLS).in("id", pageIds);
      if (cancelled) return;
      const byId = new Map((full || []).map((d: any) => [d.id, d]));
      setDocs(pageIds.map((id) => byId.get(id)).filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [filtered, docPage]);

  useEffect(() => {
    setDocPage(0);
    setSelectedDoc(null);
    setChannelFilter("todos");
  }, [period]);

  useEffect(() => {
    setDocPage(0);
    setSelectedDoc(null);
  }, [channelFilter, typeFilter, statusFilter, linkFilter, payFilter, q]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const clearFilters = () => {
    setQ("");
    setChannelFilter("todos");
    setTypeFilter("todos");
    setStatusFilter("todos");
    setLinkFilter("todos");
    setPayFilter("todas");
  };

  const hasActiveFilters = q.trim() !== ""
    || channelFilter !== "todos"
    || typeFilter !== "todos"
    || statusFilter !== "todos"
    || linkFilter !== "todos"
    || payFilter !== "todas";

  const syncDocs = async () => {
    setDocSyncing(true);
    setDocSyncMsg("Sincronizando...");
    try {
      const { from: dateFrom, to: dateTo } = chileMonthUnixRange(period);
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { date_from: dateFrom, date_to: dateTo, max_pages: 20 },
      });
      if (error) throw error;
      setDocSyncMsg(`✅ ${data?.summary?.total_upserted ?? 0} documentos`);
      await fetchDocs();
    } catch (error: any) {
      setDocSyncMsg(`❌ ${error?.message || "Error"}`);
    } finally {
      setDocSyncing(false);
    }
  };

  const totalPages = Math.ceil(docsTotal / PAGE_SIZE);
  const kpis = [
    { label: "Documentos", value: docsLoading ? "—" : docsTotal.toLocaleString("es-CL"), sub: "en el período" },
    { label: "Total documental", value: docsLoading || docsSum === null ? "—" : CLP(docsSum), sub: "boletas, facturas y NC" },
    { label: "IVA del período", value: docsLoading || docsIva === null ? "—" : CLP(docsIva), sub: "IVA neto documental" },
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
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded"><ChevronLeft className="h-5 w-5" /></button>
            <span className="text-base font-semibold capitalize w-40 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded"><ChevronRight className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...ALL_CHANNELS].map((ch) => (
              <button key={ch} onClick={() => setChannelFilter(ch)} className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${channelFilter === ch ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"}`}>
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-start justify-between mb-4 gap-4">
          <div className="grid grid-cols-3 gap-3 flex-1">
            {kpis.map(({ label, value, sub }) => (
              <div key={label} className="bg-white border rounded-lg p-3">
                <p className="text-xs text-slate-400 mb-0.5">{label}</p>
                <p className="text-xl font-bold text-slate-800">{value}</p>
                <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            {docSyncMsg && <span className={`text-xs ${docSyncMsg.includes("❌") ? "text-red-500" : "text-green-600"}`}>{docSyncMsg}</span>}
            <button onClick={syncDocs} disabled={docSyncing || docsLoading} className="flex items-center gap-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm">
              {docSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync Bsale
            </button>
          </div>
        </div>

        <div className="bg-white border rounded-lg p-3 mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Nº documento, RUT, orden, referencia…"
              className="text-xs pl-7 pr-3 py-1.5 border rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-slate-300"
            />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Todos los tipos</option>
            <option value="boleta">Boleta</option>
            <option value="factura">Factura</option>
            <option value="nota_credito">Nota de crédito</option>
            <option value="nota_debito">Nota de débito</option>
            <option value="factura_exenta">Factura exenta</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Todo estado</option>
            <option value="issued">Vigente</option>
            <option value="voided">Anulado</option>
          </select>
          <select value={linkFilter} onChange={(e) => setLinkFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todos">Toda venta asociada</option>
            <option value="con">Con venta</option>
            <option value="sin">Sin venta</option>
          </select>
          <select value={payFilter} onChange={(e) => setPayFilter(e.target.value)} className="text-xs px-2 py-1.5 border rounded-md bg-white">
            <option value="todas">Toda forma de pago</option>
            {payOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="__sin__">Sin información</option>
          </select>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs px-2.5 py-1.5 rounded-md text-slate-500 hover:bg-slate-100 inline-flex items-center gap-1">
              <X className="h-3.5 w-3.5" /> Limpiar
            </button>
          )}
          <div className="relative ml-auto">
            <button onClick={() => setColsOpen((v) => !v)} className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Columnas
            </button>
            {colsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                <div className="absolute right-0 mt-1 z-20 w-56 bg-white border rounded-lg shadow-lg p-2">
                  <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b">
                    <span className="text-[11px] uppercase tracking-wider text-slate-400">Columnas</span>
                    <button onClick={() => setVisible(new Set(DEFAULT_COLS))} className="text-[11px] text-sky-600 hover:underline">Por defecto</button>
                  </div>
                  {COLUMNS.map((c) => (
                    <label key={c.key} className={`flex items-center gap-2 px-1 py-1 text-xs rounded ${c.fixed ? "text-slate-400" : "text-slate-600 hover:bg-slate-50 cursor-pointer"}`}>
                      <input type="checkbox" disabled={c.fixed} checked={c.fixed || visible.has(c.key)} onChange={() => toggleCol(c.key)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs text-slate-500">
                {shownCols.map((c) => (
                  <th key={c.key} className={`px-4 py-3 font-medium whitespace-nowrap ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
                ))}
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {docsLoading ? (
                <tr><td colSpan={shownCols.length + 1} className="text-center py-12 text-slate-400"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...</td></tr>
              ) : docs.length === 0 ? (
                <tr><td colSpan={shownCols.length + 1} className="text-center py-12 text-slate-400 text-sm">Sin documentos para los filtros aplicados.</td></tr>
              ) : docs.map((d) => (
                <tr key={d.id} className={`border-b last:border-0 hover:bg-slate-50 ${d.status === "voided" ? "opacity-40" : ""}`}>
                  {shownCols.map((c) => (
                    <td key={c.key} className={`px-4 py-2.5 whitespace-nowrap ${c.align === "right" ? "text-right" : ""}`}>{renderCell(d, c.key)}</td>
                  ))}
                  <td className="px-4 py-2.5"><button onClick={() => setSelectedDoc(d)} className="text-slate-300 hover:text-slate-500"><Info className="h-3.5 w-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-slate-400">Página {docPage + 1} de {totalPages} · {docsTotal} documentos</span>
            <div className="flex gap-2">
              <button onClick={() => setDocPage((p) => Math.max(0, p - 1))} disabled={docPage === 0 || docsLoading} className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"><ChevronLeft className="h-3.5 w-3.5" /> Anterior</button>
              <button onClick={() => setDocPage((p) => Math.min(totalPages - 1, p + 1))} disabled={docPage >= totalPages - 1 || docsLoading} className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">Siguiente <ChevronRight className="h-3.5 w-3.5" /></button>
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
