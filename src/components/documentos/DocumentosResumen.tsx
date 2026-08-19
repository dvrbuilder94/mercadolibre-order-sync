import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { chileMonthDateRange } from "@/lib/chileDate";
import { signedTaxDocumentAmount } from "@/lib/financialRules";
import { isRealSale } from "@/lib/orderStatus";
import { CHANNEL_LABEL } from "@/lib/constants";

const CLP = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(n || 0);

const DOC_LABEL: Record<string, string> = {
  boleta: "Boletas",
  factura: "Facturas",
  factura_exenta: "Facturas exentas",
  nota_credito: "Notas de crédito",
  nota_debito: "Notas de débito",
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

type Props = {
  period: string;
  channelFilter: string;
  onReview?: () => void;
};

type SummaryState = {
  documentsIssued: number;
  realSales: number;
  documentedSales: number;
  undocumentedSales: number;
  unlinkedDocuments: number;
  cancelledLinkedDocuments: number;
  net: number;
  tax: number;
  total: number;
  creditNotes: number;
  creditNotesAmount: number;
  composition: Array<{ type: string; count: number; amount: number }>;
  channels: Array<{ channel: string; count: number; amount: number }>;
};

const EMPTY: SummaryState = {
  documentsIssued: 0,
  realSales: 0,
  documentedSales: 0,
  undocumentedSales: 0,
  unlinkedDocuments: 0,
  cancelledLinkedDocuments: 0,
  net: 0,
  tax: 0,
  total: 0,
  creditNotes: 0,
  creditNotesAmount: 0,
  composition: [],
  channels: [],
};

export default function DocumentosResumen({ period, channelFilter, onReview }: Props) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryState>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const { from, to } = chileMonthDateRange(period);

        const allDocs: any[] = [];
        const DOC_COLS = "id, document_type, document_date, net_amount, tax_amount, total_amount, status, detected_channel, raw_data, order_tax_documents(order_id, orders(status, channel))";
        for (let page = 0; page < 50; page++) {
          const { data, error } = await (supabase.from("tax_documents") as any)
            .select(DOC_COLS)
            .gte("document_date", from)
            .lte("document_date", to)
            .order("document_date", { ascending: false })
            .range(page * 1000, page * 1000 + 999);
          if (error) throw error;
          const batch = data || [];
          allDocs.push(...batch);
          if (batch.length < 1000) break;
        }

        const docsFiltered = allDocs.filter((doc: any) => {
          if (channelFilter === "todos") return true;
          return inferChannel(doc.detected_channel, doc.raw_data) === channelFilter;
        });
        const vigenteDocs = docsFiltered.filter((doc: any) => doc.status !== "voided");

        const allOrders: any[] = [];
        for (let page = 0; page < 50; page++) {
          let query = supabase
            .from("orders")
            .select("id, status, channel, order_date")
            .gte("order_date", `${from}T00:00:00-04:00`)
            .lt("order_date", `${to}T23:59:59.999-04:00`)
            .order("order_date", { ascending: false })
            .range(page * 1000, page * 1000 + 999);
          if (channelFilter !== "todos") query = query.eq("channel", channelFilter as any);
          const { data, error } = await query;
          if (error) throw error;
          const batch = data || [];
          allOrders.push(...batch);
          if (batch.length < 1000) break;
        }

        const realOrders = allOrders.filter((order: any) => isRealSale(order.status));
        const realOrderIds = realOrders.map((order: any) => order.id);
        const documentedIds = new Set<string>();

        for (let i = 0; i < realOrderIds.length; i += 300) {
          const { data: links, error } = await supabase
            .from("order_tax_documents")
            .select("order_id, tax_documents(status)")
            .in("order_id", realOrderIds.slice(i, i + 300));
          if (error) throw error;
          for (const link of links || []) {
            const td: any = Array.isArray((link as any).tax_documents)
              ? (link as any).tax_documents[0]
              : (link as any).tax_documents;
            if (td && td.status !== "voided") documentedIds.add((link as any).order_id);
          }
        }

        let unlinkedDocuments = 0;
        let cancelledLinkedDocuments = 0;
        for (const doc of vigenteDocs) {
          const links = doc.order_tax_documents || [];
          const statuses = links
            .map((link: any) => Array.isArray(link.orders) ? link.orders[0]?.status : link.orders?.status)
            .filter(Boolean);
          if (statuses.some((status: string) => isRealSale(status))) continue;
          if (statuses.length > 0) cancelledLinkedDocuments++;
          else unlinkedDocuments++;
        }

        const compositionMap = new Map<string, { count: number; amount: number }>();
        const channelMap = new Map<string, { count: number; amount: number }>();
        let net = 0;
        let tax = 0;
        let total = 0;
        let creditNotes = 0;
        let creditNotesAmount = 0;

        for (const doc of vigenteDocs) {
          const signedNet = signedTaxDocumentAmount(doc.document_type, Number(doc.net_amount || 0));
          const signedTax = signedTaxDocumentAmount(doc.document_type, Number(doc.tax_amount || 0));
          const signedTotal = signedTaxDocumentAmount(doc.document_type, Number(doc.total_amount || 0));
          net += signedNet;
          tax += signedTax;
          total += signedTotal;

          const comp = compositionMap.get(doc.document_type) || { count: 0, amount: 0 };
          comp.count += 1;
          comp.amount += signedTotal;
          compositionMap.set(doc.document_type, comp);

          if (doc.document_type === "nota_credito") {
            creditNotes += 1;
            creditNotesAmount += Math.abs(signedTotal);
          }

          const channel = inferChannel(doc.detected_channel, doc.raw_data) || "sin_detectar";
          const cur = channelMap.get(channel) || { count: 0, amount: 0 };
          cur.count += 1;
          cur.amount += signedTotal;
          channelMap.set(channel, cur);
        }

        if (!cancelled) {
          setSummary({
            documentsIssued: vigenteDocs.length,
            realSales: realOrders.length,
            documentedSales: documentedIds.size,
            undocumentedSales: Math.max(0, realOrders.length - documentedIds.size),
            unlinkedDocuments,
            cancelledLinkedDocuments,
            net,
            tax,
            total,
            creditNotes,
            creditNotesAmount,
            composition: Array.from(compositionMap.entries())
              .map(([type, value]) => ({ type, ...value }))
              .sort((a, b) => b.count - a.count),
            channels: Array.from(channelMap.entries())
              .map(([channel, value]) => ({ channel, ...value }))
              .sort((a, b) => b.count - a.count),
          });
        }
      } catch (error) {
        console.error("Error cargando resumen documental:", error);
        if (!cancelled) setSummary(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [period, channelFilter]);

  const coverage = summary.realSales > 0
    ? Math.round((summary.documentedSales / summary.realSales) * 1000) / 10
    : 0;

  const maxComposition = useMemo(
    () => Math.max(1, ...summary.composition.map((row) => row.count)),
    [summary.composition],
  );
  const maxChannels = useMemo(
    () => Math.max(1, ...summary.channels.map((row) => row.count)),
    [summary.channels],
  );

  const kpis = [
    { label: "Documentos emitidos", value: summary.documentsIssued.toLocaleString("es-CL"), sub: "DTE vigentes del período" },
    { label: "Ventas documentadas", value: summary.documentedSales.toLocaleString("es-CL"), sub: "ventas reales con DTE", tone: "text-emerald-600" },
    { label: "Ventas sin documento", value: summary.undocumentedSales.toLocaleString("es-CL"), sub: "ventas reales sin DTE", tone: summary.undocumentedSales > 0 ? "text-amber-600" : "text-emerald-600" },
    { label: "Documentos sin venta asociada", value: summary.unlinkedDocuments.toLocaleString("es-CL"), sub: "DTE vigentes sin venta real", tone: summary.unlinkedDocuments > 0 ? "text-amber-600" : "text-emerald-600" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="bg-white border rounded-lg p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">{kpi.label}</p>
            <p className={`text-2xl font-bold mt-2 ${kpi.tone || "text-slate-900"}`}>
              {loading ? "—" : kpi.value}
            </p>
            <p className="text-xs text-slate-400 mt-1">{kpi.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-white border rounded-lg p-5">
        <h2 className="font-semibold text-slate-900">De venta a documento</h2>
        <p className="text-sm text-slate-400 mt-1">Cobertura tributaria de las ventas reales del período.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 items-end">
          <div><p className="text-xs text-slate-400">Ventas reales</p><p className="text-2xl font-bold">{loading ? "—" : summary.realSales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Con DTE</p><p className="text-2xl font-bold text-emerald-600">{loading ? "—" : summary.documentedSales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Sin DTE</p><p className="text-2xl font-bold text-amber-600">{loading ? "—" : summary.undocumentedSales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Cobertura documental</p><p className="text-2xl font-bold">{loading ? "—" : `${coverage}%`}</p></div>
        </div>
        <div className="h-2 rounded-full bg-slate-100 mt-5 overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, coverage)}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded-lg p-5">
          <h2 className="font-semibold text-slate-900">Resultado documental del período</h2>
          <p className="text-sm text-slate-400 mt-1">Boletas, facturas y débitos suman; notas de crédito restan.</p>
          <div className="grid grid-cols-2 gap-4 mt-5">
            <div><p className="text-xs text-slate-400">Neto</p><p className="text-xl font-bold">{loading ? "—" : CLP(summary.net)}</p></div>
            <div><p className="text-xs text-slate-400">IVA</p><p className="text-xl font-bold">{loading ? "—" : CLP(summary.tax)}</p></div>
            <div><p className="text-xs text-slate-400">Total documental</p><p className="text-xl font-bold text-emerald-600">{loading ? "—" : CLP(summary.total)}</p></div>
            <div><p className="text-xs text-slate-400">Notas de crédito</p><p className="text-xl font-bold text-red-500">{loading ? "—" : `${summary.creditNotes.toLocaleString("es-CL")} · ${CLP(summary.creditNotesAmount)}`}</p></div>
          </div>
        </div>

        <div className="bg-white border rounded-lg p-5">
          <h2 className="font-semibold text-slate-900">Estado de conciliación documental</h2>
          <p className="text-sm text-slate-400 mt-1">DTE del período y su relación con ventas reales.</p>
          <div className="grid grid-cols-2 gap-3 mt-5">
            <div className="border rounded-lg p-3"><p className="text-xs text-slate-400">Vinculados a venta real</p><p className="text-xl font-bold text-emerald-600">{loading ? "—" : (summary.documentsIssued - summary.unlinkedDocuments - summary.cancelledLinkedDocuments).toLocaleString("es-CL")}</p></div>
            <div className="border rounded-lg p-3"><p className="text-xs text-slate-400">Sin venta</p><p className="text-xl font-bold text-amber-600">{loading ? "—" : summary.unlinkedDocuments.toLocaleString("es-CL")}</p></div>
            <div className="border rounded-lg p-3"><p className="text-xs text-slate-400">Venta cancelada / revisar NC</p><p className="text-xl font-bold text-red-500">{loading ? "—" : summary.cancelledLinkedDocuments.toLocaleString("es-CL")}</p></div>
            <div className="border rounded-lg p-3 flex items-center justify-between gap-3"><div><p className="text-xs text-slate-400">Acción</p><p className="text-sm font-medium mt-1">Revisar excepciones</p></div>{onReview && <button onClick={onReview} className="px-3 py-1.5 text-xs font-medium border rounded-md hover:bg-slate-50">Ir a Revisión</button>}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded-lg p-5">
          <h2 className="font-semibold text-slate-900">Composición documental</h2>
          <div className="space-y-4 mt-5">
            {summary.composition.map((row) => (
              <div key={row.type}>
                <div className="flex items-center justify-between gap-3 text-sm"><span>{DOC_LABEL[row.type] || row.type}</span><span className="text-slate-500">{row.count.toLocaleString("es-CL")} · {CLP(row.amount)}</span></div>
                <div className="h-2 bg-slate-100 rounded-full mt-1.5 overflow-hidden"><div className="h-full bg-slate-500" style={{ width: `${(row.count / maxComposition) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border rounded-lg p-5">
          <h2 className="font-semibold text-slate-900">Por canal</h2>
          <div className="space-y-4 mt-5">
            {summary.channels.map((row) => (
              <div key={row.channel}>
                <div className="flex items-center justify-between gap-3 text-sm"><span>{row.channel === "sin_detectar" ? "Sin detectar" : (CHANNEL_LABEL[row.channel] || row.channel)}</span><span className="text-slate-500">{row.count.toLocaleString("es-CL")} · {CLP(row.amount)}</span></div>
                <div className="h-2 bg-slate-100 rounded-full mt-1.5 overflow-hidden"><div className="h-full bg-slate-500" style={{ width: `${(row.count / maxChannels) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
