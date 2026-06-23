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
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";
import { linkIsVigente } from "@/lib/taxDocs";
import { NON_SALE_STATUSES, NON_SALE_STATUSES_PG } from "@/lib/orderStatus";

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

// Just digits — DV lives in DB but adds visual noise in dense tables.
const formatRut = (body: string | null) => {
  if (!body) return "—";
  return body.replace(/[^0-9Kk]/g, "") || "—";
};

const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

export default function PageVentas() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [channelFilter, setChannelFilter] = useState<string>("todos");

  // Orders tab
  const [orders, setOrders] = useState<any[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersWithoutDoc, setOrdersWithoutDoc] = useState(0);
  const [ordersSum, setOrdersSum] = useState<number | null>(null);
  const [ordersListTotal, setOrdersListTotal] = useState(0);
  // Ventas descartadas (canceladas/rechazadas/inválidas): visibles pero fuera de los totales.
  const [discardedCount, setDiscardedCount] = useState(0);
  const [discardedSum, setDiscardedSum] = useState<number | null>(null);
  const [orderPage, setOrderPage] = useState(0);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [orderSyncing, setOrderSyncing] = useState(false);
  const [orderSyncMsg, setOrderSyncMsg] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);
  const [docStatusFilter, setDocStatusFilter] = useState<"todos" | "con" | "sin">("todos");
  const [orderSearchInput, setOrderSearchInput] = useState("");
  const [orderSearch, setOrderSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setOrderSearch(orderSearchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [orderSearchInput]);

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
      const applyChannel = (q: any) => channelFilter !== "todos" ? q.eq("channel", channelFilter) : q;
      const applySearch = (q: any) => {
        const term = orderSearch.replace(/[,()]/g, "");
        if (!term) return q;
        return q.or(`order_id.ilike.%${term}%,customer_name.ilike.%${term}%,product_title.ilike.%${term}%,customer_tax_id.ilike.%${term}%`);
      };
      // Las ventas descartadas (canceladas, rechazadas, inválidas) no entran a
      // ningún total — la plata nunca entró. Se cuentan aparte para la tarjeta.
      const applyBase = (q: any) =>
        applySearch(applyChannel(q.gte("order_date", f).lte("order_date", t).not("status", "in", NON_SALE_STATUSES_PG)));

      // Don't use !left(id) + is-null as an anti-join here: in PostgREST that
      // filter only restricts which NESTED rows show up, not which top-level
      // orders are returned — so it silently matched every order regardless
      // of doc-link status (confirmed: "Sin documento" showed the full total).
      // Instead, fetch ids in scope and the full linked-order-id set as two
      // plain queries, then compute con/sin client-side — slower but correct.
      const scopeRows: { id: string; order_date: string }[] = [];
      for (let page = 0; page < 20; page++) {
        const { data } = await applyBase(supabase.from("orders").select("id, order_date"))
          .order("order_date", { ascending: false })
          .order("id", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (!data || data.length === 0) break;
        scopeRows.push(...(data as any));
        if (data.length < 1000) break;
      }

      // Solo cuenta como "con documento" un vínculo a un DTE vigente (no anulado),
      // igual que el resto de la app (ver src/lib/taxDocs). Por eso traemos el
      // status del documento embebido y filtramos con linkIsVigente.
      const linkedIds = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const { data } = await supabase.from("order_tax_documents")
          .select("order_id, tax_documents(status)")
          .order("id", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (!data || data.length === 0) break;
        for (const r of data as any[]) if (linkIsVigente(r)) linkedIds.add(r.order_id);
        if (data.length < 1000) break;
      }

      setOrdersTotal(scopeRows.length);
      setOrdersWithoutDoc(scopeRows.filter(o => !linkedIds.has(o.id)).length);

      const { data: sumRows } = await applyBase(supabase.from("orders").select("gross_amount.sum()"));
      const rawSum = (sumRows as any)?.[0];
      const parsedSum = rawSum != null ? Number(rawSum?.sum ?? rawSum?.gross_amount) : NaN;
      setOrdersSum(Number.isFinite(parsedSum) ? parsedSum : null);

      // Descartadas del período (mismo canal, sin filtro de búsqueda/documento):
      // se muestran como contexto pero no suman a ningún total.
      let discQ = supabase.from("orders")
        .select("gross_amount", { count: "exact" })
        .gte("order_date", f).lte("order_date", t)
        .in("status", NON_SALE_STATUSES as unknown as string[]);
      if (channelFilter !== "todos") discQ = discQ.eq("channel", channelFilter);
      const { data: discRows, count: discCount } = await discQ;
      setDiscardedCount(discCount ?? 0);
      setDiscardedSum((discRows ?? []).reduce((s: number, r: any) => s + (r.gross_amount ?? 0), 0));

      const filteredIds = scopeRows
        .filter(o => docStatusFilter === "con" ? linkedIds.has(o.id) : docStatusFilter === "sin" ? !linkedIds.has(o.id) : true)
        .map(o => o.id);
      setOrdersListTotal(filteredIds.length);

      const pageIds = filteredIds.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
      if (pageIds.length === 0) {
        setOrders([]);
      } else {
        const { data: full } = await supabase
          .from("orders")
          .select(`
            id, order_id, order_date, status, channel, customer_name, customer_tax_id,
            customer_tax_id_dv, product_title, gross_amount, net_amount, payment_method,
            installments, money_release_date, payment_approved_at, has_exact_data, raw_data,
            discount_amount, shipping_cost, commission_percentage, commission_amount,
            settlement_amount, currency_id,
            order_tax_documents(id, tax_documents(document_number, document_type, external_url, status))
          `)
          .in("id", pageIds);
        const byId = new Map((full || []).map((o: any) => [o.id, o]));
        setOrders(pageIds.map((id) => byId.get(id)).filter((o: any) => o !== undefined));
      }
    } finally {
      setOrdersLoading(false);
    }
  }, [period, channelFilter, docStatusFilter, orderSearch]);

  useEffect(() => { setOrderPage(0); setSelectedOrder(null); setChannelFilter("todos"); setDocStatusFilter("todos"); setOrderSearchInput(""); }, [period]);
  useEffect(() => { setOrderPage(0); setSelectedOrder(null); }, [channelFilter]);
  useEffect(() => { setOrderPage(0); setSelectedOrder(null); }, [docStatusFilter, orderSearch]);
  useEffect(() => { fetchOrders(orderPage); }, [fetchOrders, orderPage]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const syncOrders = async () => {
    setOrderSyncing(true); setOrderSyncMsg("Sincronizando...");
    try {
      // Sync the period currently being viewed, not the function's "last 30
      // days" default — otherwise clicking sync while looking at an older
      // month silently fetches recent orders instead and nothing changes.
      const { from, to } = periodRange(period);
      const { data, error } = await supabase.functions.invoke("sync-meli-orders", {
        body: { date_from: from + "T00:00:00", date_to: to + "T23:59:59", max_pages: 50 },
      });
      if (error) throw error;
      setOrderSyncMsg(`✅ ${data?.synced || 0} órdenes`);
      fetchOrders(orderPage);
    } catch (e: any) {
      setOrderSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally { setOrderSyncing(false); }
  };

  // Linked doc helper — muestra el primer DTE vigente (no anulado), consistente
  // con el conteo "con/sin documento" de los KPIs.
  const getLinkedDoc = (o: any) => {
    const links = (o.order_tax_documents as any[]) ?? [];
    const link = links.find(linkIsVigente);
    if (!link) return null;
    const td = link.tax_documents;
    return Array.isArray(td) ? td[0] : td;
  };

  const orderTotalPages = Math.ceil(ordersListTotal / PAGE_SIZE);

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

        {/* Canal filter */}
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

        <>
          <div className="flex items-center justify-between mb-4">
              <div className="grid grid-cols-5 gap-3 flex-1 mr-4">
                {[
                  { label: "Órdenes",       value: ordersLoading ? "—" : ordersTotal,                                              sub: "ventas reales" },
                  { label: "Total ventas",  value: ordersLoading || ordersSum === null ? "—" : CLP(ordersSum),                    sub: "bruto mensual" },
                  { label: "Con documento", value: ordersLoading ? "—" : Math.max(ordersTotal - ordersWithoutDoc, 0),             sub: "con boleta/factura", color: "text-emerald-600" },
                  { label: "Sin documento", value: ordersLoading ? "—" : ordersWithoutDoc,                                        sub: "sin DTE",
                    color: ordersWithoutDoc > 0 ? "text-red-600" : "text-emerald-600" },
                  { label: "Descartadas",   value: ordersLoading ? "—" : discardedCount,
                    sub: discardedSum && discardedSum > 0 ? `${CLP(discardedSum)} · no suma al total` : "canceladas/rechazadas",
                    color: discardedCount > 0 ? "text-slate-500" : "text-slate-800" },
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

            <div className="flex items-center gap-2 mb-3">
              <input
                type="text"
                value={orderSearchInput}
                onChange={(e) => setOrderSearchInput(e.target.value)}
                placeholder="Buscar por orden, cliente, producto o RUT"
                className="flex-1 max-w-sm px-3 py-1.5 text-sm border rounded-lg placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
              <select
                value={docStatusFilter}
                onChange={(e) => setDocStatusFilter(e.target.value as "todos" | "con" | "sin")}
                className="px-3 py-1.5 text-sm border rounded-lg text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-slate-400"
              >
                <option value="todos">Todos los estados</option>
                <option value="con">Con documento</option>
                <option value="sin">Sin documento</option>
              </select>
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
                      {channelFilter === "todos" && docStatusFilter === "todos" && !orderSearch
                        ? "Sin órdenes. Prueba Sync MeLi."
                        : "Sin órdenes que coincidan con el filtro."}
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
                          {formatRut(o.customer_tax_id)}
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
                <span className="text-xs text-slate-400">Página {orderPage + 1} de {orderTotalPages} · {ordersListTotal} órdenes</span>
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
      </main>

      {selectedOrder && (
        <DetailPanel title={`Orden · ${selectedOrder.order_id}`} data={selectedOrder} onClose={() => setSelectedOrder(null)} />
      )}
    </div>
  );
}
