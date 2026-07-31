import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { NON_SALE_STATUSES_PG } from "@/lib/orderStatus";
import {
  PeriodControlDocLink,
  PeriodControlOrder,
  PeriodControlPaymentLink,
  PeriodControlSummary,
  summarizePeriodControl,
} from "@/lib/periodControl";

const periodRange = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01T00:00:00`,
    to: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59`,
  };
};

export function useMeliPeriodControl(period: string) {
  const [data, setData] = useState<PeriodControlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchControl = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = periodRange(period);
      const orders: PeriodControlOrder[] = [];
      for (let page = 0; page < 20; page++) {
        const { data: rows, error: ordersError } = await supabase
          .from("orders")
          .select("id, gross_amount, money_release_date")
          .eq("channel", "meli")
          .gte("order_date", from)
          .lte("order_date", to)
          .not("status", "in", NON_SALE_STATUSES_PG)
          .order("order_date", { ascending: false })
          .order("id", { ascending: true })
          .range(page * 1000, page * 1000 + 999);
        if (ordersError) throw ordersError;
        const batch = (rows || []) as PeriodControlOrder[];
        orders.push(...batch);
        if (batch.length < 1000) break;
      }

      const docLinks: PeriodControlDocLink[] = [];
      const paymentLinks: PeriodControlPaymentLink[] = [];
      const ids = orders.map((order) => order.id);
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200);
        const [{ data: docs, error: docsError }, { data: payments, error: paymentsError }] =
          await Promise.all([
            supabase
              .from("order_tax_documents")
              .select("order_id, allocated_amount, tax_documents(status, document_type)")
              .in("order_id", chunk),
            supabase
              .from("payment_sales")
              .select("sale_id, allocated_amount, payments(id, raw_data)")
              .in("sale_id", chunk),
          ]);
        if (docsError) throw docsError;
        if (paymentsError) throw paymentsError;
        docLinks.push(...((docs || []) as unknown as PeriodControlDocLink[]));
        paymentLinks.push(...((payments || []) as unknown as PeriodControlPaymentLink[]));
      }

      setData(summarizePeriodControl(orders, docLinks, paymentLinks));
    } catch (cause) {
      console.error("Error calculando control de cifras:", cause);
      setData(null);
      setError(cause instanceof Error ? cause.message : "No se pudieron comparar las cifras");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchControl();
  }, [fetchControl]);

  return { data, loading, error, refresh: fetchControl };
}
