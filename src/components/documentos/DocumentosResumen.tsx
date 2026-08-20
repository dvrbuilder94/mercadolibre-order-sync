import { useEffect, useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
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

const PIE_COLORS = ["#0ea5e9", "#14b8a6", "#f59e0b", "#a855f7", "#ef4444", "#64748b", "#84cc16", "#f97316"];
const UNKNOWN_PAYMENT = "Sin información";

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
  const hit = detectChannelFromText(rawData?.reference_reason);
  if (hit) return hit;
  const refs: any[] = rawData?.references?.items ?? [];
  for (const ref of refs) {
    const h = detectChannelFromText(ref.reason) ?? detectChannelFromText(String(ref.number ?? ""));
    if (h) return h;
  }
  return null;
}

function paymentNames(rawData: any): string[] {
  const names = rawData?.payment_method_names;
  if (!Array.isArray(names)) return [];
  return Array.from(new Set(names.map((name: any) => String(name || "").trim()).filter(Boolean)));
}

/**
 * Distribuye el monto del DTE entre formas de pago sin duplicarlo.
 * - Si Bsale trae `payments[].amount`, usa esa proporción y escala al total del DTE.
 * - Si sólo hay una forma conocida, usa el total completo del DTE.
 * - Si no hay desglose suficiente, clasifica el monto como "Sin información".
 * Las NC se excluyen: son ajustes tributarios, no medios de pago.
 */
function addPaymentAmounts(doc: any, map: Map<string, number>) {
  if (doc.document_type === "nota_credito") return;
  const docTotal = Math.max(0, Number(doc.total_amount || 0));
  if (docTotal <= 0) return;

  const rawData = doc.raw_data || {};
  const rawPayments = Array.isArray(rawData.payments) ? rawData.payments : [];
  const amountRows = rawPayments
    .map((payment: any) => ({
      name: String(payment?.payment_type_name || "").trim() || UNKNOWN_PAYMENT,
      amount: Number(payment?.amount),
    }))
    .filter((payment: { name: string; amount: number }) => Number.isFinite(payment.amount) && payment.amount > 0);

  if (amountRows.length > 0) {
    const sourceTotal = amountRows.reduce((sum: number, payment: { amount: number }) => sum + payment.amount, 0);
    if (sourceTotal > 0) {
      for (const payment of amountRows) {
        const allocated = docTotal * (payment.amount / sourceTotal);
        map.set(payment.name, (map.get(payment.name) || 0) + allocated);
      }
      return;
    }
  }

  const names = paymentNames(rawData);
  const name = names.length === 1 ? names[0] : UNKNOWN_PAYMENT;
  map.set(name, (map.get(name) || 0) + docTotal);
}

type Props = {
  period: string;
  channelFilter: string;
};

type SummaryState = {
  documentsIssued: number;
  sales: number;
  documentedSales: number;
  undocumentedSales: number;
  net: number;
  tax: number;
  total: number;
  creditNotes: number;
  creditNotesAmount: number;
  composition: Array<{ type: string; count: number; amount: number }>;
  channels: Array<{ channel: string; count: number; amount: number }>;
  paymentMethods: Array<{ name: string; amount: number }>;
};

const EMPTY: SummaryState = {
  documentsIssued: 0,
  sales: 0,
  documentedSales: 0,
  undocumentedSales: 0,
  net: 0,
  tax: 0,
  total: 0,
  creditNotes: 0,
  creditNotesAmount: 0,
  composition: [],
  channels: [],
  paymentMethods: [],
};

export default function DocumentosResumen({ period, channelFilter }: Props) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryState>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const { from, to } = chileMonthDateRange(period);

        const allDocs: any[] = [];
        const DOC_COLS = "id, document_type, document_date, net_amount, tax_amount, total_amount, status, detected_channel, raw_data";
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

        const sales = allOrders.filter((order: any) => isRealSale(order.status));
        const saleIds = sales.map((order: any) => order.id);
        const documentedIds = new Set<string>();

        for (let i = 0; i < saleIds.length; i += 300) {
          const { data: links, error } = await supabase
            .from("order_tax_documents")
            .select("order_id, tax_documents(status)")
            .in("order_id", saleIds.slice(i, i + 300));
          if (error) throw error;
          for (const link of links || []) {
            const td: any = Array.isArray((link as any).tax_documents)
              ? (link as any).tax_documents[0]
              : (link as any).tax_documents;
            if (td && td.status !== "voided") documentedIds.add((link as any).order_id);
          }
        }

        const compositionMap = new Map<string, { count: number; amount: number }>();
        const channelMap = new Map<string, { count: number; amount: number }>();
        const paymentMethodMap = new Map<string, number>();
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

          addPaymentAmounts(doc, paymentMethodMap);
        }

        if (!cancelled) {
          setSummary({
            documentsIssued: vigenteDocs.length,
            sales: sales.length,
            documentedSales: documentedIds.size,
            undocumentedSales: Math.max(0, sales.length - documentedIds.size),
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
            paymentMethods: Array.from(paymentMethodMap.entries())
              .map(([name, amount]) => ({ name, amount }))
              .filter((row) => row.amount > 0)
              .sort((a, b) => b.amount - a.amount),
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

  const coverage = summary.sales > 0
    ? Math.round((summary.documentedSales / summary.sales) * 1000) / 10
    : 0;

  const maxComposition = useMemo(
    () => Math.max(1, ...summary.composition.map((row) => row.count)),
    [summary.composition],
  );
  const maxChannels = useMemo(
    () => Math.max(1, ...summary.channels.map((row) => row.count)),
    [summary.channels],
  );
  const paymentMethodsTotal = useMemo(
    () => summary.paymentMethods.reduce((sum, row) => sum + row.amount, 0),
    [summary.paymentMethods],
  );
  const paymentPieData = useMemo(
    () => summary.paymentMethods.map((row) => ({ name: row.name, value: Math.round(row.amount) })),
    [summary.paymentMethods],
  );

  const kpis = [
    { label: "Documentos emitidos", value: summary.documentsIssued.toLocaleString("es-CL"), sub: "DTE vigentes del período" },
    { label: "Ventas documentadas", value: summary.documentedSales.toLocaleString("es-CL"), sub: "ventas con DTE", tone: "text-emerald-600" },
    { label: "Ventas sin documento", value: summary.undocumentedSales.toLocaleString("es-CL"), sub: "ventas sin DTE", tone: summary.undocumentedSales > 0 ? "text-amber-600" : "text-emerald-600" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
        <p className="text-sm text-slate-400 mt-1">Cobertura tributaria de las ventas del período.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 items-end">
          <div><p className="text-xs text-slate-400">Ventas del período</p><p className="text-2xl font-bold">{loading ? "—" : summary.sales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Con DTE</p><p className="text-2xl font-bold text-emerald-600">{loading ? "—" : summary.documentedSales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Sin DTE</p><p className="text-2xl font-bold text-amber-600">{loading ? "—" : summary.undocumentedSales.toLocaleString("es-CL")}</p></div>
          <div><p className="text-xs text-slate-400">Cobertura documental</p><p className="text-2xl font-bold">{loading ? "—" : `${coverage}%`}</p></div>
        </div>
        <div className="h-2 rounded-full bg-slate-100 mt-5 overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, coverage)}%` }} />
        </div>
      </div>

      <div className="bg-white border rounded-lg p-5">
        <h2 className="font-semibold text-slate-900">Resultado documental del período</h2>
        <p className="text-sm text-slate-400 mt-1">Boletas, facturas y débitos suman; notas de crédito restan.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
          <div><p className="text-xs text-slate-400">Neto</p><p className="text-xl font-bold">{loading ? "—" : CLP(summary.net)}</p></div>
          <div><p className="text-xs text-slate-400">IVA</p><p className="text-xl font-bold">{loading ? "—" : CLP(summary.tax)}</p></div>
          <div><p className="text-xs text-slate-400">Total documental</p><p className="text-xl font-bold text-emerald-600">{loading ? "—" : CLP(summary.total)}</p></div>
          <div><p className="text-xs text-slate-400">Notas de crédito</p><p className="text-xl font-bold text-red-500">{loading ? "—" : `${summary.creditNotes.toLocaleString("es-CL")} · ${CLP(summary.creditNotesAmount)}`}</p></div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border rounded-lg p-5">
          <h2 className="font-semibold text-slate-900">Forma de pago</h2>
          <p className="text-sm text-slate-400 mt-1">Distribución por monto de los DTE de venta vigentes.</p>

          {loading ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-slate-400">Cargando…</div>
          ) : paymentPieData.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-slate-400">Sin datos de forma de pago.</div>
          ) : (
            <>
              <div className="relative h-[220px] mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={paymentPieData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={48}
                      outerRadius={78}
                      paddingAngle={2}
                    >
                      {paymentPieData.map((_, index) => (
                        <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: any) => CLP(Number(value))} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                  <span className="text-[11px] text-slate-400">Monto</span>
                  <span className="text-sm font-semibold text-slate-800">{CLP(paymentMethodsTotal)}</span>
                </div>
              </div>

              <div className="space-y-2 mt-1">
                {summary.paymentMethods.map((row, index) => {
                  const pct = paymentMethodsTotal > 0 ? (row.amount / paymentMethodsTotal) * 100 : 0;
                  return (
                    <div key={row.name} className="flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                        <span className="text-slate-600 truncate" title={row.name}>{row.name}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-medium text-slate-700">{CLP(row.amount)}</span>
                        <span className="text-slate-400 ml-1.5">{pct.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400 mt-4">Notas de crédito excluidas de esta distribución.</p>
            </>
          )}
        </div>

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
