import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, RefreshCw, Loader2, ShieldCheck, ChevronDown, ChevronUp,
} from "lucide-react";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";
import { orderHasDoc } from "@/lib/taxDocs";
import { DetailPanel } from "@/components/DetailPanel";
import { fetchOrderDetail } from "@/lib/orderDetail";

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};
const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};
const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 })
    .format(n || 0);

const PAGE_SIZE = 50;

type StatusFilter = "all" | "pendiente" | "liberado";

// Eje temporal del período. En una liquidación conviven TRES fechas distintas y
// mezclarlas es lo que hacía ambiguo el "junio" de arriba:
//   - order_date          → cuándo VENDISTE
//   - payment_date        → cuándo MercadoPago aprobó/procesó el pago
//   - money_release_date  → cuándo la plata queda DISPONIBLE para retirar
// Para una vista de tesorería el eje que importa es la liberación (cuándo la
// plata es tuya). El payment_date pasa a ser un dato de la fila, no un eje.
//   - "liberacion": plata cuya fecha de liberación cae en el mes. Verdad de caja.
//   - "venta":      a qué venta corresponde (order_date) — misma cohorte que Ventas,
//                   para poder cruzar venta↔payout aunque la plata caiga otro mes.
type DateBasis = "liberacion" | "venta";

// Fila cruda: un pago real de MercadoPago (payments) con las órdenes que
// cubre (payment_sales → orders) y si cada una ya tiene documento tributario.
interface PaySaleOrder {
  id: string; order_id: string; channel: string | null; product_title: string | null;
  gross_amount: number | null; money_release_date: string | null; order_date: string | null;
  has_exact_data: boolean | null;
  order_tax_documents: { id: string; tax_documents: { status: string | null } | null }[] | null;
}
interface PaymentRow {
  id: string;
  external_payment_id: string | null;
  payment_date: string;
  net_amount: number | null;
  fees_amount: number | null;
  gross_amount: number | null;
  payment_sales: { allocated_amount: number; orders: PaySaleOrder | null }[] | null;
  raw_data: { ledger_type?: string } | null;
}

// sync-meli-settlements (no expuesto en ningún botón hoy, pero sigue desplegado
// y alcanzable) escribe filas en payments que NO vienen de MercadoPago: agrupa
// nuestras propias órdenes por fecha de liberación y las re-empaqueta como un
// "pago" sintético (external_payment_id = MELI_<seller>_<fecha>, monto = Σ
// ventas del día). Se marca a sí mismo con raw_data.ledger_type = LOGICAL_BATCH.
// Solo sync-meli-payment-details trae datos reales de la API de pagos de
// MercadoPago — hay que excluir lo sintético explícitamente, porque ambos
// comparten la misma tabla y el mismo payment_provider.
const isRealMpPayment = (p: PaymentRow) => p.raw_data?.ledger_type !== "LOGICAL_BATCH";

// Unidad de liquidación derivada — lo que de verdad le importa al usuario:
// cuánto le depositaron, por qué venta(s), y si ya está respaldado con
// documento tributario y liberado en su saldo.
interface Liquidacion {
  key: string;
  externalPaymentId: string | null;
  paymentDate: string;
  net: number;
  fees: number;
  gross: number;
  channels: string[];
  orders: { id: string; orderId: string; title: string | null; amount: number; hasDoc: boolean; hasExact: boolean }[];
  docsOk: number;
  liberado: boolean;
  latestRelease: string | null;
  // money_release_date es exacto solo cuando MercadoPago lo confirmó
  // (has_exact_data). Si alguna orden del pago no está confirmada, la fecha de
  // liberación es una estimación (order_date + ~14d) y se marca como tal.
  exactRelease: boolean;
}

const toLiquidacion = (p: PaymentRow): Liquidacion => {
  const links = p.payment_sales || [];
  const orders = links
    .filter((l) => l.orders)
    .map((l) => ({
      id: l.orders!.id, orderId: l.orders!.order_id, title: l.orders!.product_title,
      amount: l.allocated_amount, hasDoc: orderHasDoc(l.orders!.order_tax_documents),
      hasExact: !!l.orders!.has_exact_data,
    }));
  const channels = Array.from(new Set(links.map((l) => l.orders?.channel).filter(Boolean) as string[]));
  const releaseDates = links.map((l) => l.orders?.money_release_date).filter(Boolean) as string[];
  const latestRelease = releaseDates.length > 0
    ? releaseDates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;
  return {
    key: p.id,
    externalPaymentId: p.external_payment_id,
    paymentDate: p.payment_date,
    net: p.net_amount || 0,
    fees: p.fees_amount || 0,
    gross: p.gross_amount || 0,
    channels, orders,
    docsOk: orders.filter((o) => o.hasDoc).length,
    liberado: latestRelease ? new Date(latestRelease) <= new Date() : true,
    latestRelease,
    exactRelease: orders.length > 0 && orders.every((o) => o.hasExact),
  };
};

// Vista agrupada: muchas liquidaciones comparten la misma fecha de liberación
// (es el mismo depósito de MercadoPago) — sin esto, un período con miles de
// ventas se ve como miles de filas casi idénticas en vez de un puñado de
// depósitos reales.
interface ReleaseGroup {
  key: string;
  releaseDate: string | null;
  liberado: boolean;
  net: number;
  count: number;
  docsOk: number;
  ordersCount: number;
  channels: string[];
  items: Liquidacion[];
}
const groupByRelease = (items: Liquidacion[]): ReleaseGroup[] => {
  const map = new Map<string, ReleaseGroup>();
  for (const l of items) {
    const key = l.latestRelease ? l.latestRelease.slice(0, 10) : "sin-fecha";
    let g = map.get(key);
    if (!g) {
      g = {
        key, releaseDate: l.latestRelease ? l.latestRelease.slice(0, 10) : null,
        liberado: l.liberado, net: 0, count: 0, docsOk: 0, ordersCount: 0, channels: [], items: [],
      };
      map.set(key, g);
    }
    g.net += l.net;
    g.count += 1;
    g.docsOk += l.docsOk;
    g.ordersCount += l.orders.length;
    for (const ch of l.channels) if (!g.channels.includes(ch)) g.channels.push(ch);
    g.items.push(l);
  }
  return Array.from(map.values()).sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
};

type OrphanReason = "sin_referencia" | "sin_orden" | "orden_cerrada" | "falta_sync";
interface OrphanResult {
  totalChecked: number; unmatchedCount: number; unmatchedAmount: number;
  unmatched: {
    id: string; amount: number; date_approved: string;
    external_reference: string | null; reason: OrphanReason; label: string;
  }[];
}
// Por qué un pago de MercadoPago no aparece en la tabla de liquidaciones — no
// todos los casos son "plata perdida": falta_sync y orden_cerrada son brechas
// de sincronización, sin_orden es el único caso realmente sin explicar.
const REASON_BADGE: Record<OrphanReason, string> = {
  sin_orden: "bg-red-100 text-red-700",
  falta_sync: "bg-amber-100 text-amber-700",
  orden_cerrada: "bg-blue-100 text-blue-700",
  sin_referencia: "bg-slate-100 text-slate-500",
};
const REASON_SHORT: Record<OrphanReason, string> = {
  sin_orden: "Sin orden",
  falta_sync: "Falta sync",
  orden_cerrada: "Orden cerrada",
  sin_referencia: "Sin referencia",
};

export default function PageLiquidaciones() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [grouped, setGrouped] = useState(false);
  const [dateBasis, setDateBasis] = useState<DateBasis>("liberacion");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Detalle de orden — mismo panel de cadena que PageVentas/PageConciliacion,
  // traído on-demand (esta tabla embebe la orden vía payment_sales y no trae
  // los campos completos que el panel necesita).
  const [detailOrder, setDetailOrder] = useState<any | null>(null);
  const openOrderDetail = useCallback(async (id: string) => {
    try { setDetailOrder(await fetchOrderDetail(id)); } catch { /* ignore */ }
  }, []);

  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<OrphanResult | null>(null);

  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = range;
      const f = from + "T00:00:00", t = to + "T23:59:59";
      const EMBED = `
        id, external_payment_id, payment_date, net_amount, fees_amount, gross_amount, raw_data,
        payment_sales (
          allocated_amount,
          orders ( id, order_id, channel, product_title, gross_amount, order_date, money_release_date, has_exact_data,
                   order_tax_documents ( id, tax_documents ( status ) ) )
        )
      `;
      const acc: PaymentRow[] = [];

      // Ambos ejes parten de las órdenes del período y de ahí traen sus pagos
      // (con TODOS sus payment_sales, sin recortar, para que el neto siga siendo
      // el del depósito completo). Lo único que cambia es por qué fecha de la
      // orden filtramos: money_release_date (caja) u order_date (venta).
      const orderDateCol = dateBasis === "venta" ? "order_date" : "money_release_date";

      const orderIds: string[] = [];
      for (let p = 0; p < 20; p++) {
        const { data } = await supabase.from("orders").select("id")
          .gte(orderDateCol, f).lte(orderDateCol, t)
          .range(p * 1000, p * 1000 + 999);
        if (!data || data.length === 0) break;
        orderIds.push(...data.map((o: any) => o.id));
        if (data.length < 1000) break;
      }

      const paymentIds = new Set<string>();
      for (let i = 0; i < orderIds.length; i += 200) {
        const { data } = await supabase.from("payment_sales")
          .select("payment_id").in("sale_id", orderIds.slice(i, i + 200));
        for (const r of (data || []) as any[]) if (r.payment_id) paymentIds.add(r.payment_id);
      }

      const ids = Array.from(paymentIds);
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from("payments").select(EMBED)
          .eq("payment_provider", "MERCADOPAGO")
          .in("id", ids.slice(i, i + 200));
        if (error) throw error;
        acc.push(...((data || []) as unknown as PaymentRow[]).filter(isRealMpPayment));
      }
      acc.sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || ""));

      setRows(acc);
    } catch (e) {
      console.error("Error cargando liquidaciones:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [range, dateBasis]);

  useEffect(() => { fetchRows(); }, [fetchRows]);
  useEffect(() => {
    setPage(0); setExpanded(null); setAuditResult(null); setAuditOpen(false);
  }, [range.from, range.to, statusFilter, channelFilter, grouped, dateBasis]);

  const liquidaciones = useMemo(() => rows.map(toLiquidacion), [rows]);

  // Canales presentes — base para el filtro y para dejar la vista lista para
  // multicanal sin inventar canales que no existen (hoy solo MercadoLibre).
  const channels = useMemo(
    () => Array.from(new Set(liquidaciones.flatMap((l) => l.channels))).sort(),
    [liquidaciones]
  );

  const kpis = useMemo(() => {
    let liberado = 0, pendiente = 0, comisiones = 0, sinDocumento = 0;
    for (const l of liquidaciones) {
      if (l.liberado) liberado += l.net; else pendiente += l.net;
      comisiones += l.fees;
      if (l.orders.length > 0 && l.docsOk < l.orders.length) sinDocumento++;
    }
    return { liberado, pendiente, comisiones, sinDocumento, count: liquidaciones.length };
  }, [liquidaciones]);

  const filtered = useMemo(() => {
    return liquidaciones.filter((l) => {
      if (statusFilter !== "all" && (statusFilter === "liberado" ? !l.liberado : l.liberado)) return false;
      if (channelFilter !== "all" && !l.channels.includes(channelFilter)) return false;
      return true;
    });
  }, [liquidaciones, statusFilter, channelFilter]);

  const groups = useMemo(() => (grouped ? groupByRelease(filtered) : []), [grouped, filtered]);
  const displayCount = grouped ? groups.length : filtered.length;
  const totalPages = Math.max(1, Math.ceil(displayCount / PAGE_SIZE));
  const pageLiquidaciones = grouped ? [] : filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageGroups = grouped ? groups.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : [];
  const COLS = grouped ? 8 : 11;

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const runAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { from, to } = range;
      const { data, error } = await supabase.functions.invoke("check-orphan-payments", {
        body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "error desconocido");
      setAuditResult({
        totalChecked: data.totalChecked, unmatchedCount: data.unmatchedCount,
        unmatchedAmount: data.unmatchedAmount, unmatched: data.unmatched ?? [],
      });
    } catch (e: any) {
      setAuditError(e?.message || "No se pudo consultar MercadoPago");
    } finally {
      setAuditLoading(false);
    }
  };

  const channelBadges = (chs: string[]) => (
    <div className="flex flex-col gap-1">
      {chs.length > 0 ? chs.map((ch) => (
        <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-600"}`}>
          {CHANNEL_LABEL[ch] ?? ch}
        </span>
      )) : <span className="text-slate-300">—</span>}
    </div>
  );
  const docBadge = (ok: number, of: number) => of === 0 ? (
    <span className="text-slate-300">—</span>
  ) : ok === of ? (
    <span className="text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-700 w-fit">✓ {ok}/{of}</span>
  ) : (
    <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700 w-fit">{ok}/{of} · falta</span>
  );
  const stateBadge = (liberado: boolean, dateStr?: string | null) => (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium w-fit ${liberado ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
      {liberado ? "Liberado" : "Pendiente"}
      {dateStr ? ` ${format(new Date(dateStr), "dd/MM", { locale: es })}` : ""}
    </span>
  );
  // Fecha de liberación con marca de estimada (≈) cuando MercadoPago no la confirmó.
  const releaseCell = (l: Liquidacion) => l.latestRelease ? (
    <span>
      {l.latestRelease.slice(0, 10)}
      {!l.exactRelease && (
        <span title="Fecha estimada (orden sin confirmación de MercadoPago, ~14 días)" className="text-amber-500"> ≈</span>
      )}
    </span>
  ) : <span className="text-slate-300">—</span>;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-6xl">

        <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Tesorería</p>
            <h2 className="text-lg font-semibold text-slate-800">Liquidaciones</h2>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="w-52 text-center">
              <h1 className="text-xl font-semibold capitalize leading-none">{periodLabel(period)}</h1>
              <p className="text-[11px] text-slate-400 mt-1">
                {dateBasis === "venta" ? "por fecha de venta" : "por fecha de liberación"}
              </p>
            </div>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
            <button onClick={fetchRows} disabled={loading}
              className="ml-1 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* KPIs: lo que de verdad importa de la tesorería — cuánta plata ya está
            disponible, cuánta falta liberar, cuánto te cobró el riel de pago, y
            si falta respaldo tributario. Siempre reflejan todo el período. */}
        <div className="grid grid-cols-4 gap-4 mb-6 mt-5">
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Neto liberado</p>
            <p className="text-xl font-bold text-green-600 tabular-nums">{clp(kpis.liberado)}</p>
            <p className="text-xs text-slate-400 mt-1">Ya disponible · {kpis.count} pagos</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Pendiente de liberación</p>
            <p className="text-xl font-bold text-amber-600 tabular-nums">{clp(kpis.pendiente)}</p>
            <p className="text-xs text-slate-400 mt-1">Aprobado, aún no disponible</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Comisiones</p>
            <p className="text-xl font-bold text-slate-900 tabular-nums">{clp(kpis.comisiones)}</p>
            <p className="text-xs text-slate-400 mt-1">Lo que te cobró MercadoPago</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Sin documento</p>
            <p className={`text-xl font-bold tabular-nums ${kpis.sinDocumento > 0 ? "text-red-600" : "text-slate-900"}`}>
              {kpis.sinDocumento}
            </p>
            <p className="text-xs text-slate-400 mt-1">liquidaciones con venta sin DTE</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {([
            ["all", "Todas"], ["pendiente", "Pendientes"], ["liberado", "Liberadas"],
          ] as [StatusFilter, string][]).map(([val, label]) => (
            <button key={val} onClick={() => setStatusFilter(val)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                statusFilter === val
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
              }`}>
              {label}
            </button>
          ))}

          {/* Filtro de canal: aparece solo cuando hay más de uno. Hoy la columna
              "Canal" ya muestra el riel por fila; el filtro queda listo para
              cuando entren Shopify u otros, sin simular canales inexistentes. */}
          {channels.length > 1 && (
            <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}
              className="ml-auto text-xs border border-slate-200 rounded-full px-2.5 py-1 text-slate-600 bg-white">
              <option value="all">Todos los canales</option>
              {channels.map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch] ?? ch}</option>)}
            </select>
          )}

          {/* Eje temporal: la misma plata cae en meses distintos según se mire
              por fecha de liberación (caja) o de venta (cruce con Ventas). */}
          <div className={`${channels.length > 1 ? "" : "ml-auto"} flex items-center gap-1 rounded-full border border-slate-200 p-0.5`}
            title="MercadoPago libera la plata ~14 días después de la venta: el mismo mes 'por liberación' y 'por venta' agrupan liquidaciones distintas.">
            {([
              ["liberacion", "Por liberación"], ["venta", "Por venta"],
            ] as [DateBasis, string][]).map(([val, label]) => (
              <button key={val} onClick={() => setDateBasis(val)}
                className={`px-2.5 py-0.5 text-xs font-medium rounded-full transition-colors ${
                  dateBasis === val ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-700"
                }`}>
                {label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)}
              className="rounded border-slate-300" />
            Agrupar por fecha de liberación
          </label>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              {grouped ? (
                <tr className="text-left text-xs text-slate-400 border-b">
                  <th className="px-4 py-2 font-medium">Fecha liberación</th>
                  <th className="px-4 py-2 font-medium">Canal</th>
                  <th className="px-4 py-2 font-medium">Liquidaciones</th>
                  <th className="px-4 py-2 font-medium text-right">Monto neto</th>
                  <th className="px-4 py-2 font-medium">Venta(s)</th>
                  <th className="px-4 py-2 font-medium">Documento</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              ) : (
                <tr className="text-left text-xs text-slate-400 border-b">
                  <th className="px-4 py-2 font-medium">Payment ID</th>
                  <th className="px-4 py-2 font-medium">Canal</th>
                  <th className="px-4 py-2 font-medium">F. pago</th>
                  <th className="px-4 py-2 font-medium">F. liberación</th>
                  <th className="px-4 py-2 font-medium text-right">Bruto</th>
                  <th className="px-4 py-2 font-medium text-right">Comisión</th>
                  <th className="px-4 py-2 font-medium text-right">Neto</th>
                  <th className="px-4 py-2 font-medium">Venta(s)</th>
                  <th className="px-4 py-2 font-medium">Documento</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              )}
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={COLS} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </td></tr>
              ) : displayCount === 0 ? (
                <tr><td colSpan={COLS} className="px-4 py-10 text-center text-slate-400">
                  Sin liquidaciones de MercadoPago en este período. Corre <b>Sync pagos</b> en{" "}
                  <a href="/pipeline" className="text-blue-500 underline">Sincronización</a> si esperabas ver datos acá.
                </td></tr>
              ) : grouped ? pageGroups.map((g) => {
                const isOpen = expanded === g.key;
                return (
                  <Fragment key={g.key}>
                    <tr className="border-b last:border-0 hover:bg-slate-50 align-top cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : g.key)}>
                      <td className="px-4 py-2 text-slate-500">
                        {g.releaseDate ? format(new Date(g.releaseDate), "dd/MM/yyyy") : "Sin fecha"}
                      </td>
                      <td className="px-4 py-2">{channelBadges(g.channels)}</td>
                      <td className="px-4 py-2 text-slate-500">{g.count} pagos</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{clp(g.net)}</td>
                      <td className="px-4 py-2 text-slate-500">{g.ordersCount} órdenes</td>
                      <td className="px-4 py-2">{docBadge(g.docsOk, g.ordersCount)}</td>
                      <td className="px-4 py-2">{stateBadge(g.liberado)}</td>
                      <td className="px-4 py-2 text-slate-400">
                        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b bg-slate-50">
                        <td colSpan={8} className="px-4 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-slate-400 border-b">
                                <th className="py-1 font-medium">Pago ID</th>
                                <th className="py-1 font-medium">Canal</th>
                                <th className="py-1 font-medium">Venta(s)</th>
                                <th className="py-1 font-medium text-right">Monto neto</th>
                                <th className="py-1 font-medium">Documento</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.items.map((l) => (
                                <tr key={l.key} className="border-b last:border-0">
                                  <td className="py-1 font-mono text-slate-500">{l.externalPaymentId || "—"}</td>
                                  <td className="py-1 text-slate-600">{l.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "—"}</td>
                                  <td className="py-1 text-slate-700 truncate max-w-[220px]">
                                    {l.orders.length === 0 ? "—" : l.orders.map((o, i) => (
                                      <span key={o.id}>
                                        {i > 0 && ", "}
                                        <span className="cursor-pointer hover:text-blue-600 hover:underline"
                                          onClick={() => openOrderDetail(o.id)}>
                                          {o.title || o.orderId}
                                        </span>
                                      </span>
                                    ))}
                                  </td>
                                  <td className="py-1 text-right tabular-nums">{clp(l.net)}</td>
                                  <td className="py-1">{docBadge(l.docsOk, l.orders.length)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              }) : pageLiquidaciones.map((l) => {
                const isOpen = expanded === l.key;
                const multi = l.orders.length > 1;
                return (
                  <Fragment key={l.key}>
                    <tr className="border-b last:border-0 hover:bg-slate-50 align-top cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : l.key)}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{l.externalPaymentId || "—"}</td>
                      <td className="px-4 py-2">{channelBadges(l.channels)}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{l.paymentDate.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{releaseCell(l)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{clp(l.gross)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{clp(l.fees)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{clp(l.net)}</td>
                      <td className="px-4 py-2">
                        <div className="space-y-1">
                          {l.orders.slice(0, multi ? 1 : undefined).map((o) => (
                            <div key={o.id} className="flex items-center justify-between gap-3 cursor-pointer hover:text-blue-600"
                              onClick={(e) => { e.stopPropagation(); openOrderDetail(o.id); }}>
                              <span className="truncate max-w-[200px] text-slate-700">{o.title || o.orderId}</span>
                              {!multi && <span className="tabular-nums text-xs text-slate-400 shrink-0">{clp(o.amount)}</span>}
                            </div>
                          ))}
                        </div>
                        {multi && (
                          <div className="text-[10px] text-slate-400 mt-1">{l.orders.length} órdenes en este pago</div>
                        )}
                      </td>
                      <td className="px-4 py-2">{docBadge(l.docsOk, l.orders.length)}</td>
                      <td className="px-4 py-2">{stateBadge(l.liberado, l.latestRelease)}</td>
                      <td className="px-4 py-2 text-slate-400">
                        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b bg-slate-50">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="grid grid-cols-3 gap-4 mb-3 text-xs">
                            <div><span className="text-slate-400">Bruto: </span><span className="tabular-nums">{clp(l.gross)}</span></div>
                            <div><span className="text-slate-400">Comisión MP: </span><span className="tabular-nums">{clp(l.fees)}</span></div>
                            <div><span className="text-slate-400">Neto recibido: </span><span className="tabular-nums font-medium">{clp(l.net)}</span></div>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-slate-400 border-b">
                                <th className="py-1 font-medium">Orden</th>
                                <th className="py-1 font-medium text-right">Venta</th>
                                <th className="py-1 font-medium">Documento</th>
                              </tr>
                            </thead>
                            <tbody>
                              {l.orders.map((o) => (
                                <tr key={o.id} className="border-b last:border-0 cursor-pointer hover:bg-slate-100"
                                  onClick={() => openOrderDetail(o.id)}>
                                  <td className="py-1 text-slate-700">{o.title || o.orderId} <span className="font-mono text-slate-400">({o.orderId})</span></td>
                                  <td className="py-1 text-right tabular-nums">{clp(o.amount)}</td>
                                  <td className="py-1">
                                    {o.hasDoc
                                      ? <span className="text-green-600">✓ Con documento</span>
                                      : <span className="text-red-600">Sin documento</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && displayCount > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-slate-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, displayCount)} de {displayCount}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-3">
          Cada fila es un pago real aprobado por MercadoPago, con la(s) venta(s) que cubre. El monto neto es lo
          que efectivamente te depositaron (ya descontada la comisión) — no una estimación.{" "}
          {dateBasis === "venta"
            ? "Estás viendo los pagos de las ventas de este mes (la misma cohorte que Ventas), aunque la plata se libere en otro mes."
            : "Estás viendo la plata que se libera este mes (cuándo queda disponible para retirar); muchas ventas son de meses anteriores, porque MercadoPago libera ~14 días después. La fecha marcada con ≈ es estimada."}
        </p>

        {/* Auditoría: esta es la única vista que le pregunta directo a MercadoPago
            "qué te pagaron", en vez de preguntarle a nuestras propias órdenes "¿te
            pagaron?". Sirve para encontrar pagos que el resto del pipeline nunca
            llegó a vincular a una venta — por eso vive aparte, no en la tabla
            principal (que solo puede mostrar lo que ya conocemos). */}
        <div className="mt-8 border-t pt-4">
          <button onClick={() => setAuditOpen((v) => !v)}
            className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800">
            <ShieldCheck className="h-4 w-4" />
            Auditar contra MercadoPago directamente
            {auditOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {auditOpen && (
            <div className="mt-3">
              <p className="text-xs text-slate-400 mb-3">
                Consulta <code>/v1/payments/search</code> directo en MercadoPago para este período — independiente
                de nuestras órdenes. Sirve para detectar pagos que MercadoPago aprobó y que esta tabla nunca
                llegó a ver, porque ninguna orden nuestra los referenció.
              </p>
              <button onClick={runAudit} disabled={auditLoading}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white text-sm font-medium rounded-lg mb-3">
                {auditLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verificar
              </button>
              {auditError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{auditError}</div>
              )}
              {auditResult && (() => {
                const byReason = auditResult.unmatched.reduce((acc, p) => {
                  acc[p.reason] = (acc[p.reason] || 0) + 1;
                  return acc;
                }, {} as Record<OrphanReason, number>);
                const sinOrdenCount = byReason.sin_orden || 0;
                return (
                  <div className="bg-white border rounded-lg p-4">
                    <p className="text-sm mb-2">
                      MercadoPago aprobó <b>{auditResult.totalChecked}</b> pagos este período.{" "}
                      {auditResult.unmatchedCount === 0 ? (
                        <span className="text-green-700">✓ Todos están reflejados arriba.</span>
                      ) : (
                        <span>
                          <b>{auditResult.unmatchedCount}</b> ({clp(auditResult.unmatchedAmount)}) no están en la tabla de
                          liquidaciones, pero no todos son plata sin explicar —{" "}
                          {sinOrdenCount > 0 ? (
                            <span className="text-red-700 font-medium">{sinOrdenCount} sin ninguna orden asociada</span>
                          ) : (
                            <span className="text-green-700 font-medium">ninguno está realmente sin explicar</span>
                          )}, el resto son brechas de sincronización (ver detalle abajo).
                        </span>
                      )}
                    </p>
                    {auditResult.unmatched.length > 0 && (
                      <>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          {(Object.keys(REASON_SHORT) as OrphanReason[]).filter((r) => byReason[r]).map((r) => (
                            <span key={r} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${REASON_BADGE[r]}`}>
                              {REASON_SHORT[r]} · {byReason[r]}
                            </span>
                          ))}
                        </div>
                        <table className="w-full text-xs mt-2">
                          <thead>
                            <tr className="text-left text-slate-400 border-b">
                              <th className="py-1 font-medium">Payment ID</th>
                              <th className="py-1 font-medium text-right">Monto</th>
                              <th className="py-1 font-medium">Fecha</th>
                              <th className="py-1 font-medium">Motivo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {auditResult.unmatched.map((p) => (
                              <tr key={p.id} className="border-b last:border-0 align-top">
                                <td className="py-1 font-mono text-slate-500">{p.id}</td>
                                <td className="py-1 text-right tabular-nums">{clp(p.amount)}</td>
                                <td className="py-1 text-slate-500">{p.date_approved?.slice(0, 10)}</td>
                                <td className="py-1">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${REASON_BADGE[p.reason]}`}>
                                    {REASON_SHORT[p.reason]}
                                  </span>
                                  <div className="text-slate-400 mt-0.5">{p.label}</div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </main>

      {detailOrder && (
        <DetailPanel title={`Orden · ${detailOrder.order_id}`} data={detailOrder} onClose={() => setDetailOrder(null)} />
      )}
    </div>
  );
}
