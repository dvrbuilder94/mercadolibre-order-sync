import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Nav } from "@/components/Nav";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { DetailPanel } from "@/components/DetailPanel";
import { fetchOrderDetail } from "@/lib/orderDetail";
import { TesoreriaResumen } from "@/components/tesoreria/TesoreriaResumen";
import { TesoreriaMovimientos } from "@/components/tesoreria/TesoreriaMovimientos";
import { TesoreriaCargos } from "@/components/tesoreria/TesoreriaCargos";
import {
  clp, onlyRealMpPayments, toTesoreriaPayment, TesoreriaPaymentRaw,
} from "@/lib/tesoreria";
import { chileMonthIsoRange, chilePeriodNow } from "@/lib/chileDate";
import type { MonthlyControlSnapshot } from "@/lib/monthlyControl";
import { MonthlyControlPanel } from "@/components/tesoreria/MonthlyControlPanel";

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const EMBED = `
  id, external_payment_id, payment_provider, payment_date,
  net_amount, fees_amount, gross_amount, amount, status, raw_data,
  payment_sales (
    allocated_amount,
    orders (
      id, order_id, channel, customer_name, product_title,
      gross_amount, order_date, money_release_date,
      installments, payment_method, has_exact_data, raw_data,
      order_tax_documents (
        id,
        tax_documents ( id, status, document_number, external_url, document_type )
      )
    )
  )
`;

export default function PageTesoreria() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState(chilePeriodNow);
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<"resumen" | "detalle" | "cargos">(
    requestedTab === "detalle" || requestedTab === "cargos" ? requestedTab : "resumen",
  );
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "partial" | "orphan">("all");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<TesoreriaPaymentRaw[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<TesoreriaPaymentRaw[]>([]);
  const [unpaidOrders, setUnpaidOrders] = useState<Array<{
    id: string;
    order_id: string;
    gross_amount: number | null;
  }>>([]);
  const [detailOrder, setDetailOrder] = useState<any | null>(null);
  const [monthlyControl, setMonthlyControl] = useState<MonthlyControlSnapshot | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const rangeIso = useMemo(() => chileMonthIsoRange(period), [period]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const acc: TesoreriaPaymentRaw[] = [];
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("payments")
          .select(EMBED)
          .gte("payment_date", rangeIso.from)
          .lt("payment_date", rangeIso.toExclusive)
          .order("payment_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data || []) as unknown as TesoreriaPaymentRaw[];
        acc.push(...batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      setRows(onlyRealMpPayments(acc));

      const { data: unpaid, error: unpaidError } = await supabase
        .from("orders")
        .select("id, order_id, gross_amount")
        .eq("channel", "meli")
        .eq("has_exact_data", false)
        .not("status", "in", "(cancelled,rejected,invalid)")
        .gte("order_date", rangeIso.from)
        .lt("order_date", rangeIso.toExclusive)
        .order("order_date", { ascending: false });
      if (unpaidError) throw unpaidError;
      setUnpaidOrders((unpaid || []) as Array<{
        id: string;
        order_id: string;
        gross_amount: number | null;
      }>);

      // Las próximas liberaciones usan su propia cohorte temporal (money_release_date),
      // separada de la cohorte mensual de payment_date que alimenta los movimientos.
      const today = format(new Date(), "yyyy-MM-dd'T'00:00:00");
      const in30 = format(new Date(Date.now() + 30 * 86400000), "yyyy-MM-dd'T'23:59:59");
      const { data: futureLinks } = await supabase
        .from("orders")
        .select(`
          money_release_date,
          payment_sales!inner(
            allocated_amount,
            payments!inner(id, external_payment_id, payment_date, net_amount, raw_data)
          )
        `)
        .gte("money_release_date", today)
        .lte("money_release_date", in30)
        .limit(500);
      const seen = new Set<string>();
      const futurePayments: TesoreriaPaymentRaw[] = [];
      for (const o of (futureLinks || []) as any[]) {
        for (const ps of o.payment_sales || []) {
          const p = ps.payments;
          if (!p || seen.has(p.id)) continue;
          if (p.raw_data?.ledger_type === "LOGICAL_BATCH") continue;
          seen.add(p.id);
          futurePayments.push({
            id: p.id,
            external_payment_id: p.external_payment_id,
            payment_provider: null,
            payment_date: p.payment_date,
            net_amount: p.net_amount,
            fees_amount: null,
            gross_amount: null,
            amount: null,
            status: null,
            raw_data: p.raw_data,
            payment_sales: [{
              allocated_amount: ps.allocated_amount,
              orders: {
                ...o,
                id: "",
                order_id: "",
                channel: null,
                customer_name: null,
                product_title: null,
                gross_amount: null,
                order_date: null,
                installments: null,
                payment_method: null,
                has_exact_data: null,
                raw_data: null,
                order_tax_documents: null,
              },
            }],
          });
        }
      }
      setUpcomingRows(futurePayments);

      const { data: control, error: controlError } = await (supabase as any)
        .rpc("get_monthly_control_snapshot", { p_period: period });
      if (controlError) {
        console.error("Error cargando control mensual:", controlError);
        setMonthlyControl(null);
      } else {
        setMonthlyControl(control as unknown as MonthlyControlSnapshot);
      }
    } catch (e) {
      console.error("Error cargando tesorería:", e);
      setRows([]); setUpcomingRows([]); setUnpaidOrders([]);
    } finally {
      setLoading(false);
    }
  }, [period, rangeIso]);

  const refreshTreasury = useCallback(async () => {
    setLoading(true);
    try {
      const { error } = await supabase.functions.invoke("check-orphan-payments", {
        body: {
          date_from: rangeIso.from,
          date_to: rangeIso.to,
        },
      });
      if (error) console.error("Error sincronizando caja Mercado Pago:", error);
    } catch (error) {
      console.error("Error sincronizando caja Mercado Pago:", error);
    }
    await fetchData();
  }, [fetchData, rangeIso]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const payments = useMemo(() => rows.map(toTesoreriaPayment), [rows]);
  const cashMovements = useMemo(
    () => payments.filter((payment) => payment.net !== 0),
    [payments],
  );

  const approvedNetTotal = useMemo(
    () => cashMovements.reduce((sum, payment) => sum + payment.net, 0),
    [cashMovements],
  );
  const releasedNetTotal = useMemo(
    () => cashMovements
      .filter((payment) => payment.liberado)
      .reduce((sum, payment) => sum + payment.net, 0),
    [cashMovements],
  );
  const pendingReleaseTotal = approvedNetTotal - releasedNetTotal;
  const unpaidTotal = useMemo(
    () => unpaidOrders.reduce((sum, order) => sum + (order.gross_amount || 0), 0),
    [unpaidOrders],
  );
  const orphanPayments = useMemo(
    () => payments.filter((payment) => payment.matchState === "orphan"),
    [payments],
  );
  const partialPayments = useMemo(
    () => payments.filter((payment) => payment.matchState === "partial"),
    [payments],
  );
  const paidWithoutDte = useMemo(() => {
    const orderIds = new Set<string>();
    for (const payment of payments) {
      for (const sale of payment.sales) {
        if (!sale.hasDoc) orderIds.add(sale.id);
      }
    }
    return orderIds.size;
  }, [payments]);

  const upcoming = useMemo(() => {
    const map = new Map<string, { net: number; count: number }>();
    for (const raw of upcomingRows) {
      const release = raw.payment_sales?.[0]?.orders?.money_release_date;
      if (!release) continue;
      const day = release.slice(0, 10);
      const cur = map.get(day) || { net: 0, count: 0 };
      cur.net += raw.net_amount || 0;
      cur.count += 1;
      map.set(day, cur);
    }
    return Array.from(map.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [upcomingRows]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const openOrderDetail = useCallback(async (id: string) => {
    try { setDetailOrder(await fetchOrderDetail(id)); } catch { /* ignore */ }
  }, []);

  const jumpToDetailFiltered = (filter: "orphan" | "partial") => {
    setMatchFilter(filter);
    setTab("detalle");
    setSearchParams({ tab: "detalle" }, { replace: true });
  };

  const changeTab = (value: string) => {
    const next = value as "resumen" | "detalle" | "cargos";
    setTab(next);
    setSearchParams(next === "resumen" ? {} : { tab: next }, { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Tesorería</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Tu caja operativa en Mercado Pago: qué ventas entraron, cuáles faltan y qué pagos no se pueden explicar.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => changePeriod(-1)} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium capitalize w-36 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button onClick={refreshTreasury} disabled={loading} title="Sincronizar caja desde Mercado Pago" className="p-1.5 hover:bg-slate-100 rounded text-slate-400 disabled:opacity-40 ml-1">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {monthlyControl && <MonthlyControlPanel snapshot={monthlyControl} />}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Neto aprobado MP</p>
            <p className="text-xl font-bold text-slate-900 mt-1">{clp(approvedNetTotal)}</p>
            <p className="text-[11px] text-slate-400 mt-1">{cashMovements.length} movimientos confirmados</p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Neto liberado por MP</p>
            <p className="text-xl font-bold text-emerald-600 mt-1">{clp(releasedNetTotal)}</p>
            <p className="text-[11px] text-slate-400 mt-1">{clp(pendingReleaseTotal)} pendiente de liberar</p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Pagos sin venta</p>
            <p className={`text-xl font-bold mt-1 ${orphanPayments.length > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {orphanPayments.length}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              {partialPayments.length > 0 ? `${partialPayments.length} pagos con asignación por revisar` : "sin huérfanos detectados"}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Ventas por explicar</p>
            <p className={`text-xl font-bold mt-1 ${unpaidOrders.length > 0 ? "text-amber-600" : "text-emerald-600"}`}>
              {unpaidOrders.length}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              {clp(unpaidTotal)} bruto sin pago confirmado · {paidWithoutDte} pagadas sin DTE
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="resumen">Resumen</TabsTrigger>
            <TabsTrigger value="detalle">
              Movimientos <span className="ml-1.5 text-[10px] text-slate-400">({payments.length})</span>
            </TabsTrigger>
            <TabsTrigger value="cargos">Cargos y comisiones</TabsTrigger>
          </TabsList>

          {loading && tab !== "cargos" ? (
            <div className="flex items-center justify-center py-24 text-slate-400 text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Cargando tesorería…
            </div>
          ) : (
            <>
              <TabsContent value="resumen">
                <TesoreriaResumen
                  payments={payments}
                  upcomingReleases={upcoming}
                  period={period}
                  rangeIso={rangeIso}
                  onJumpToDetail={jumpToDetailFiltered}
                />
              </TabsContent>
              <TabsContent value="detalle">
                <TesoreriaMovimientos
                  payments={payments}
                  initialMatchFilter={matchFilter}
                  onOpenOrder={openOrderDetail}
                />
              </TabsContent>
              <TabsContent value="cargos">
                <TesoreriaCargos period={period} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </main>

      {detailOrder && (
        <DetailPanel
          title={`Orden ${detailOrder.order_id ?? ""}`}
          data={detailOrder}
          onClose={() => setDetailOrder(null)}
        />
      )}
    </div>
  );
}
