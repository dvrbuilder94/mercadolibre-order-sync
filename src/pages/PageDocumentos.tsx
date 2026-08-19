import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Info, FileText } from "lucide-react";
import { chileMonthDateRange, chileMonthUnixRange, chilePeriodNow } from "@/lib/chileDate";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";
import { signedTaxDocumentAmount } from "@/lib/financialRules";

const PAGE_SIZE = 50;

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

function inferChannel(detected: string | null, rawData: any): string | null {
  if (detected) return detected;
  const hit = detectChannelFromText(rawData?.reference_reason)
    ?? detectChannelFromText(rawData?.payment_method_name);
  if (hit) return hit;
  const refs: any[] = rawData?.references?.items ?? [];
  for (const ref of refs) {
    const h = detectChannelFromText(ref.reason) ?? detectChannelFromText(String(ref.number ?? ""));
    if (h) return h;
  }
  return null;
}

const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

export default function PageDocumentos() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channelFilter, setChannelFilter] = useState("todos");
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

  const fetchDocs = useCallback(async (page: number) => {
    setDocsLoading(true);
    try {
      const { from, to } = chileMonthDateRange(period);
      const LIGHT_COLS = "id, document_type, document_date, total_amount, tax_amount, status, detected_channel, reference_reason:raw_data->>reference_reason, references:raw_data->references";
      const allDocs: any[] = [];

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
        allDocs.push(...data);
        if (data.length < 1000) break;
      }

      const filtered = channelFilter === "todos"
        ? allDocs
        : allDocs.filter((d) => inferChannel(d.detected_channel, {
            reference_reason: d.reference_reason,
            references: d.references,
          }) === channelFilter);

      setDocsTotal(filtered.length);
      const issued = filtered.filter((d) => d.status === "issued");
      setDocsSum(issued.reduce((sum, d) => sum + signedTaxDocumentAmount(d.document_type, d.total_amount), 0));
      setDocsIva(issued.reduce((sum, d) => sum + signedTaxDocumentAmount(d.document_type, d.tax_amount), 0));

      const pageIds = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((d) => d.id);
      if (!pageIds.length) {
        setDocs([]);
        return;
      }

      const FULL_COLS = "id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, detected_channel, status, external_url, external_order_id, raw_data, order_tax_documents(id, order_id)";
      const { data: full } = await supabase.from("tax_documents").select(FULL_COLS).in("id", pageIds);
      const byId = new Map((full || []).map((d: any) => [d.id, d]));
      setDocs(pageIds.map((id) => byId.get(id)).filter(Boolean));
    } catch (error) {
      console.error("Error cargando documentos:", error);
      setDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [period, channelFilter]);

  useEffect(() => {
    setDocPage(0);
    setSelectedDoc(null);
    setChannelFilter("todos");
  }, [period]);

  useEffect(() => {
    setDocPage(0);
    setSelectedDoc(null);
  }, [channelFilter]);

  useEffect(() => { fetchDocs(docPage); }, [fetchDocs, docPage]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

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
      await fetchDocs(docPage);
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

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs text-slate-500">
                <th className="text-left px-4 py-3 font-medium">Documento</th>
                <th className="text-left px-4 py-3 font-medium">Canal</th>
                <th className="text-left px-4 py-3 font-medium">Fecha</th>
                <th className="text-right px-4 py-3 font-medium">Neto</th>
                <th className="text-right px-4 py-3 font-medium">IVA</th>
                <th className="text-right px-4 py-3 font-medium">Total</th>
                <th className="text-left px-4 py-3 font-medium">Venta asociada</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {docsLoading ? (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...</td></tr>
              ) : docs.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400 text-sm">Sin documentos para los filtros aplicados.</td></tr>
              ) : docs.map((d) => {
                const effectiveChannel = inferChannel(d.detected_channel, d.raw_data);
                const links = d.order_tax_documents || [];
                return (
                  <tr key={d.id} className={`border-b last:border-0 hover:bg-slate-50 ${d.status === "voided" ? "opacity-40" : ""}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${DOC_COLOR[d.document_type] || "bg-slate-100 text-slate-600"}`}>{DOC_LABEL[d.document_type] || d.document_type}</span>
                        <span className="font-mono text-xs text-slate-500">{d.document_number}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {effectiveChannel ? <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[effectiveChannel] || "bg-slate-100 text-slate-500"}`}>{CHANNEL_LABEL[effectiveChannel] || effectiveChannel}</span> : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{d.document_date}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.net_amount)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{CLP(d.tax_amount)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold">{CLP(d.total_amount)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{links.length ? `${links.length} ${links.length === 1 ? "venta" : "ventas"}` : "—"}</td>
                    <td className="px-4 py-2.5"><button onClick={() => setSelectedDoc(d)} className="text-slate-300 hover:text-slate-500"><Info className="h-3.5 w-3.5" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
