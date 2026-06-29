import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Nav } from "@/components/Nav";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { DetailPanel } from "@/components/DetailPanel";
import { fetchOrderDetail } from "@/lib/orderDetail";
import { TesoreriaResumen } from "@/components/tesoreria/TesoreriaResumen";
import { TesoreriaDetalle } from "@/components/tesoreria/TesoreriaDetalle";
import {
  onlyRealMpPayments, toTesoreriaPayment, TesoreriaPaymentRaw, periodRange,
} from "@/lib/tesoreria";

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
      installments, payment_method,
      order_tax_documents ( id, tax_documents ( status ) )
    )
  )
`;

export default function PageTesoreria() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [tab, setTab] = useState<"resumen" | "detalle">("resumen");
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "partial" | "orphan">("all");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<TesoreriaPaymentRaw[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<TesoreriaPaymentRaw[]>([]);
  const [detailOrder, setDetailOrder] = useState<any | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const range = useMemo(() => periodRange(period), [period]);
  const rangeIso = useMemo(
    () => ({
      from: format(range.from, "yyyy-MM-dd'T'00:00:00"),
      to: format(range.to, "yyyy-MM-dd'T'23:59:59"),
    }),
    [range],
  );

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
          .lte("payment_date", rangeIso.to)
          .order("payment_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data || []) as unknown as TesoreriaPaymentRaw[];
        acc.push(...batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      setRows(onlyRealMpPayments(acc));

      // Upcoming releases: scan payments globally (no period filter) for the next 30 days
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
              orders: { ...o, id: "", order_id: "", channel: null, customer_name: null, product_title: null, gross_amount: null, order_date: null, installments: null, payment_method: null },
            }],
          });
        }
      }
      setUpcomingRows(futurePayments);
    } catch (e) {
      console.error("Error cargando tesorería:", e);
      setRows([]); setUpcomingRows([]);
    } finally {
      setLoading(false);
    }
  }, [rangeIso]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const payments = useMemo(() => rows.map(toTesoreriaPayment), [rows]);

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
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Tesorería</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Lo que la pasarela te depositó, lo que te falta liberar, y el matching contra tus ventas.
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
            <button onClick={fetchData} disabled={loading} className="p-1.5 hover:bg-slate-100 rounded text-slate-400 disabled:opacity-40 ml-1">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="mb-4">
            <TabsTrigger value="resumen">Resumen</TabsTrigger>
            <TabsTrigger value="detalle">
              Detalle <span className="ml-1.5 text-[10px] text-slate-400">({payments.length})</span>
            </TabsTrigger>
          </TabsList>

          {loading ? (
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
                <TesoreriaDetalle
                  payments={payments}
                  initialMatchFilter={matchFilter}
                  onOpenOrder={openOrderDetail}
                />
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