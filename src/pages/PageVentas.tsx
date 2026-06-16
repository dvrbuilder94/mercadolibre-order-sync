import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, RefreshCw, Loader2, Info,
  CheckCircle2, AlertCircle, FileText, ShoppingBag, ExternalLink,
} from "lucide-react";

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

const CHANNEL_LABEL: Record<string, string> = {
  meli: "MercadoLibre", falabella: "Falabella", paris: "Paris",
  ripley: "Ripley", amazon: "Amazon", shopify: "Shopify",
};
const CHANNEL_COLOR: Record<string, string> = {
  meli: "bg-yellow-100 text-yellow-800", shopify: "bg-blue-100 text-blue-700",
  falabella: "bg-orange-100 text-orange-700", paris: "bg-pink-100 text-pink-700",
  ripley: "bg-purple-100 text-purple-700", amazon: "bg-amber-100 text-amber-800",
};

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmada", paid: "Pagada", delivered: "Entregada",
  shipped: "Enviada", pending: "Pendiente",
};
const STATUS_COLOR: Record<string, string> = {
  confirmed: "text-emerald-600", paid: "text-emerald-600", delivered: "text-emerald-600",
  shipped: "text-blue-600", pending: "text-amber-500",
};

const PAYMENT_LABEL: Record<string, string> = {
  account_money: "Mercado Pago", visa: "Visa", master: "Mastercard",
  debvisa: "Débito Visa", debmaster: "Débito Mastercard", amex: "Amex",
};
const payLabel = (pm: string | null | undefined) => {
  if (!pm || pm === "unknown") return "—";
  if (PAYMENT_LABEL[pm]) return PAYMENT_LABEL[pm];
  return pm.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
};

const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Créd.",
  nota_debito: "N. Déb.", factura_exenta: "Fact. Ex.",
};
const DOC_COLOR: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700", factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700",
};

const formatRut = (body: string | null, dv?: string | null) => {
  if (!body) return "—";
  const dotted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return dv ? `${dotted}-${dv}` : dotted;
};

type Tab = "ordenes" | "docs";

export default function PageVentas() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [tab, setTab] = useState<Tab>("ordenes");

  // Orders tab
  const [orders, setOrders] = useState<any[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersWithDoc, setOrdersWithDoc] = useState(0);
  const [ordersSum, setOrdersSum] = useState<number | null>(null);
  const [orderPage, setOrderPage] = useState(0);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [orderSyncing, setOrderSyncing] = useState(false);
  const [orderSyncMsg, setOrderSyncMsg] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);

  // Docs tab
  const [docs, setDocs] = useState<any[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsMeliCount, setDocsMeliCount] = useState(0);
  const [docsSum, setDocsSum] = useState<number | null>(null);
  const [docPage, setDocPage] = useState(0);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docSyncing, setDocSyncing] = useState(false);
  const [docSyncMsg, setDocSyncMsg] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<any | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  // ── Orders fetch ───────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async (p: number) => {
    setOrdersLoading(true);
    try {
      const { from, to } = periodRange(period);
      const f = from + "T00:00:00", t = to + "T23:59:59";

      const [{ count }, { count: withDocC }, { data: sumRows }] = await Promise.all([
        supabase.from("orders").select("*", { count: "exact", head: true })
          .gte("order_date", f).lte("order_date", t).neq("status", "cancelled"),
        supabase.from("orders").select("*, order_tax_documents!inner(id)", { count: "exact", head: true })
          .gte("order_date", f).lte("order_date", t).neq("status", "cancelled"),
        supabase.from("orders").select("gross_amount.sum()")
          .gte("order_date", f).lte("order_date", t).neq("status", "cancelled"),
      ]);
      setOrdersTotal(count || 0);
      setOrdersWithDoc(withDocC || 0);
      setOrdersSum((sumRows as any)?.[0]?.sum ?? null);

      const { data } = await supabase
        .from("orders")
        .select(`
          id, order_id, order_date, status, channel, customer_name, customer_tax_id,
          customer_tax_id_dv, product_title, gross_amount, net_amount, payment_method,
          installments, money_release_date, payment_approved_at, has_exact_data, raw_data,
          order_tax_documents(
            tax_documents(document_number, document_type, external_url)
          )
        `)
        .gte("order_date", f).lte("order_date", t)
        .neq("status", "cancelled")
        .order("order_date", { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);

      setOrders(data || []);
    } finally {
      setOrdersLoading(false);
    }
  }, [period]);

  // ── Docs fetch ─────────────────────────────────────────────────────────────
  const fetchDocs = useCallback(async (p: number) => {
    setDocsLoading(true);
    try {
      const { from, to } = periodRange(period);

      const [{ count }, { count: meliC }, { data: sumRows }] = await Promise.all([
        supabase.from("tax_documents").select("*", { count: "exact", head: true })
          .gte("document_date", from).lte("document_date", to),
        supabase.from("tax_documents").select("*, order_tax_documents!inner(id)", { count: "exact", head: true })
          .gte("document_date", from).lte("document_date", to),
        supabase.from("tax_documents").select("total_amount.sum()")
          .gte("document_date", from).lte("document_date", to).eq("status", "issued"),
      ]);
      setDocsTotal(count || 0);
      setDocsMeliCount(meliC || 0);
      setDocsSum((sumRows as any)?.[0]?.sum ?? null);

      const { data } = await supabase
        .from("tax_documents")
        .select("id, document_number, document_type, document_date, total_amount, net_amount, tax_amount, client_name, client_tax_id, detected_channel, status, external_url, raw_data, order_tax_documents(id)")
        .gte("document_date", from).lte("document_date", to)
        .order("document_date", { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);

      setDocs(data || []);
    } finally {
      setDocsLoading(false);
    }
  }, [period]);

  useEffect(() => { setOrderPage(0); setDocPage(0); setSelectedOrder(null); setSelectedDoc(null); }, [period]);
  useEffect(() => { fetchOrders(orderPage); }, [fetchOrders, orderPage]);
  useEffect(() => { fetchDocs(docPage); }, [fetchDocs, docPage]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const syncOrders = async () => {
    setOrderSyncing(true); setOrderSyncMsg("Sincronizando...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-meli-orders");
      if (error) throw error;
      setOrderSyncMsg(`✅ ${data?.synced || 0} órdenes`);
      fetchOrders(orderPage);
    } catch (e: any) {
      setOrderSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally { setOrderSyncing(false); }
  };

  const syncDocs = async () => {
    setDocSyncing(true); setDocSyncMsg("Sincronizando...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", { body: { days_back: 90 } });
      if (error) throw error;
      const tot = data?.summary?.total_upserted ?? 0;
      setDocSyncMsg(`✅ ${tot} documentos`);
      fetchDocs(docPage);
    } catch (e: any) {
      setDocSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally { setDocSyncing(false); }
  };

  // Linked doc helper
  const getLinkedDoc = (o: any) => {
    const links = (o.order_tax_documents as any[]) ?? [];
    if (links.length === 0) return null;
    const td = links[0]?.tax_documents;
    return Array.isArray(td) ? td[0] : td;
  };

  const orderTotalPages = Math.ceil(ordersTotal / PAGE_SIZE);
  const docTotalPages   = Math.ceil(docsTotal / PAGE_SIZE);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-6xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <ShoppingBag className="h-5 w-5 text-slate-400" />
            <h1 className="text-xl font-semibold text-slate-900">Ventas</h1>
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

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-white border rounded-lg p-1 mb-6 w-fit">
          <button
            onClick={() => setTab("ordenes")}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${tab === "ordenes" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"}`}
          >
            Órdenes
          </button>
          <button
            onClick={() => setTab("docs")}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${tab === "docs" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"}`}
          >
            Documentos Bsale
          </button>
        </div>

        {/* ── ÓRDENES TAB ────────────────────────────────────────────────── */}
        {tab === "ordenes" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="grid grid-cols-4 gap-3 flex-1 mr-4">
                {[
                  { label: "Órdenes",       value: ordersLoading ? "—" : ordersTotal,                                              sub: "no canceladas" },
                  { label: "Total ventas",  value: ordersLoading || ordersSum === null ? "—" : CLP(ordersSum),                    sub: "bruto mensual" },
                  { label: "Con documento", value: ordersLoading ? "—" : ordersWithDoc,                                           sub: "con boleta/factura", color: "text-emerald-600" },
                  { label: "Sin documento", value: ordersLoading ? "—" : Math.max(ordersTotal - ordersWithDoc, 0),                sub: "sin DTE",
                    color: (ordersTotal - ordersWithDoc) > 0 ? "text-red-600" : "text-emerald-600" },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="bg-white border rounded-lg p-3">
                    <p className="text-xs text-slate-400 mb-0.5">{label}</p>
                    <p className={`text-xl font-bold ${color || "text-slate-800"}`}>{value}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                {orderSyncMsg && <span className={`text-xs ${orderSyncMsg.includes("❌") ? "text-red-500" : "text-green-600"}`}>{orderSyncMsg}</span>}
                <button onClick={syncOrders} disabled={orderSyncing || ordersLoading}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-40 text-yellow-900 font-medium rounded-lg text-sm">
                  {orderSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Sync MeLi
                </button>
              </div>
            </div>

            <div className="bg-white border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50 text-xs text-slate-500">
                    <th className="text-left px-3 py-3 font-medium">Canal</th>
                    <th className="text-left px-3 py-3 font-medium">Orden</th>
                    <th className="text-left px-3 py-3 font-medium">Fecha</th>
                    <th className="text-left px-3 py-3 font-medium">Cliente / Producto</th>
                    <th className="text-left px-3 py-3 font-medium">RUT</th>
                    <th className="text-right px-3 py-3 font-medium">Monto</th>
                    <th className="text-left px-3 py-3 font-medium">Medio de pago</th>
                    <th className="text-left px-3 py-3 font-medium">Liquidación</th>
                    <th className="text-left px-3 py-3 font-medium">DTE vinculado</th>
                    <th className="w-8 px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {ordersLoading ? (
                    <tr><td colSpan={10} className="text-center py-12 text-slate-400">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                    </td></tr>
                  ) : orders.length === 0 ? (
                    <tr><td colSpan={10} className="text-center py-12 text-slate-400 text-sm">
                      Sin órdenes. Prueba Sync MeLi.
                    </td></tr>
                  ) : orders.map(o => {
                    const doc = getLinkedDoc(o);
                    const isSelected = selectedOrder?.id === o.id;
                    return (
                      <tr key={o.id} className={`border-b last:border-0 hover:bg-slate-50 ${isSelected ? "bg-slate-100" : !doc ? "bg-red-50/30" : ""}`}>
                        <td className="px-3 py-2.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[o.channel] || "bg-slate-100 text-slate-600"}`}>
                            {CHANNEL_LABEL[o.channel] ?? o.channel ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-400 cursor-pointer hover:text-slate-700 select-none"
                          title={`ID: ${o.order_id}`} onClick={() => navigator.clipboard?.writeText(o.order_id)}>
                          ···{o.order_id?.slice(-8)}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">{o.order_date?.slice(0, 10)}</td>
                        <td className="px-3 py-2.5 max-w-[180px]">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-slate-800 text-xs">{o.customer_name}</span>
                            <span className={`text-[10px] font-medium shrink-0 ${STATUS_COLOR[o.status] || "text-slate-400"}`}>
                              {STATUS_LABEL[o.status] || o.status}
                            </span>
                          </div>
                          {o.product_title && <div className="text-[10px] text-slate-400 truncate mt-0.5">{o.product_title}</div>}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                          {formatRut(o.customer_tax_id, o.customer_tax_id_dv)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap">{CLP(o.gross_amount)}</td>
                        <td className="px-3 py-2.5">
                          <span className="text-xs text-slate-600">{payLabel(o.payment_method)}</span>
                          {o.installments > 1 && <span className="block text-[10px] text-slate-400">{o.installments} cuotas</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {o.money_release_date && (() => {
                            const liberado = new Date(o.money_release_date) <= new Date();
                            const exact = !!o.has_exact_data;
                            return (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit block ${
                                exact
                                  ? liberado ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-400"
                              }`}>
                                {liberado ? "Liberado" : "Pendiente"} {format(new Date(o.money_release_date), "dd/MM", { locale: es })}
                                {!exact && " est."}
                              </span>
                            );
                          })()}
                          {o.payment_approved_at && (
                            <span className="text-[10px] text-slate-400 block mt-0.5">
                              Cobrado {format(new Date(o.payment_approved_at), "dd/MM", { locale: es })}
                            </span>
                          )}
                        </td>
                        {/* KEY COLUMN: linked DTE visible directly in the orders table */}
                        <td className="px-3 py-2.5">
                          {doc ? (
                            doc.external_url ? (
                              <a href={doc.external_url} target="_blank" rel="noreferrer"
                                className="flex items-center gap-1 text-blue-600 hover:underline text-xs">
                                <FileText className="h-3 w-3 shrink-0" />
                                {DOC_LABEL[doc.document_type] || doc.document_type} {doc.document_number}
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            ) : (
                              <span className="flex items-center gap-1 text-emerald-600 text-xs">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                {DOC_LABEL[doc.document_type] || doc.document_type} {doc.document_number}
                              </span>
                            )
                          ) : (
                            <span className="flex items-center gap-1 text-red-500 text-xs font-medium">
                              <AlertCircle className="h-3.5 w-3.5" />Falta
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <button onClick={() => setSelectedOrder(isSelected ? null : o)}
                            className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}>
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {orderTotalPages > 1 && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-slate-400">Página {orderPage + 1} de {orderTotalPages} · {ordersTotal} órdenes</span>
                <div className="flex gap-2">
                  <button onClick={() => setOrderPage(p => Math.max(0, p - 1))} disabled={orderPage === 0 || ordersLoading}
                    className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">
                    <ChevronLeft className="h-3.5 w-3.5" /> Anterior
                  </button>
                  <button onClick={() => setOrderPage(p => Math.min(orderTotalPages - 1, p + 1))} disabled={orderPage >= orderTotalPages - 1 || ordersLoading}
                    className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50">
                    Siguiente <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── DOCUMENTOS BSALE TAB ────────────────────────────────────────── */}
        {tab === "docs" && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="grid grid-cols-4 gap-3 flex-1 mr-4">
                {[
                  { label: "Documentos",       value: docsLoading ? "—" : docsTotal,                                             sub: "en el período" },
                  { label: "Total facturado",  value: docsLoading || docsSum === null ? "—" : CLP(docsSum),                     sub: "documentos emitidos" },
                  { label: "Vinculados MeLi",  value: docsLoading ? "—" : docsMeliCount,                                        sub: "con orden ML", color: "text-emerald-600" },
                  { label: "Otros canales",    value: docsLoading ? "—" : Math.max(docsTotal - docsMeliCount, 0),               sub: "tienda física / web", color: "text-slate-700" },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="bg-white border rounded-lg p-3">
                    <p className="text-xs text-slate-400 mb-0.5">{label}</p>
                    <p className={`text-xl font-bold ${color || "text-slate-800"}`}>{value}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
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
                    <th className="text-left px-4 py-3 font-medium">Tipo</th>
                    <th className="text-left px-4 py-3 font-medium">Número</th>
                    <th className="text-left px-4 py-3 font-medium">Fecha</th>
                    <th className="text-left px-4 py-3 font-medium">Canal</th>
                    <th className="text-right px-4 py-3 font-medium">Monto</th>
                    <th className="text-left px-4 py-3 font-medium">RUT cliente</th>
                    <th className="text-left px-4 py-3 font-medium">Orden vinculada</th>
                    <th className="w-8 px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {docsLoading ? (
                    <tr><td colSpan={8} className="text-center py-12 text-slate-400">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                    </td></tr>
                  ) : docs.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-12 text-slate-400 text-sm">
                      Sin documentos. Prueba Sync Bsale.
                    </td></tr>
                  ) : docs.map(d => {
                    const isLinked = (d.order_tax_documents as any[])?.length > 0;
                    const isVoided = d.status === "voided";
                    const isSelected = selectedDoc?.id === d.id;
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
                            ? <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANNEL_COLOR[d.detected_channel] || "bg-slate-100 text-slate-600"}`}>
                                {CHANNEL_LABEL[d.detected_channel] || d.detected_channel}
                              </span>
                            : <span className="text-xs text-slate-300">—</span>
                          }
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">{CLP(d.total_amount)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                          {d.client_tax_id?.replace(/[^0-9]/g, "") || "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          {isVoided
                            ? <span className="text-xs text-slate-300">Anulado</span>
                            : isLinked
                              ? <span className="flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="h-3.5 w-3.5" />Sí</span>
                              : <span className="flex items-center gap-1 text-slate-300 text-xs">No</span>
                          }
                        </td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => setSelectedDoc(isSelected ? null : d)}
                            className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}>
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {docTotalPages > 1 && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-slate-400">Página {docPage + 1} de {docTotalPages} · {docsTotal} documentos</span>
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
          </>
        )}
      </main>

      {selectedOrder && (
        <DetailPanel title={`Orden · ${selectedOrder.order_id}`} data={selectedOrder} onClose={() => setSelectedOrder(null)} />
      )}
      {selectedDoc && (
        <DetailPanel title={`Bsale · ${DOC_LABEL[selectedDoc.document_type] || selectedDoc.document_type} #${selectedDoc.document_number}`} data={selectedDoc} onClose={() => setSelectedDoc(null)} />
      )}
    </div>
  );
}
