import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { DetailPanel } from "@/components/DetailPanel";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Info, CheckCircle2, Clock } from "lucide-react";

const PAGE_SIZE = 50;

const CLP = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Pagada", paid: "Pagada", delivered: "Entregada",
  shipped: "Enviada", pending: "Pendiente", cancelled: "Cancelada",
};
const STATUS_COLOR: Record<string, string> = {
  confirmed: "text-green-600", paid: "text-green-600", delivered: "text-green-600",
  shipped: "text-blue-600", pending: "text-yellow-600", cancelled: "text-slate-400",
};

export default function PageMeli() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [orders, setOrders] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [selected, setSelected] = useState<any | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchOrders = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const from_ = from + "T00:00:00";
      const to_   = to   + "T23:59:59";

      // Count
      const { count } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .gte("order_date", from_).lte("order_date", to_)
        .neq("status", "cancelled");
      setTotal(count || 0);

      // Page
      const { data } = await supabase
        .from("orders")
        .select("id, order_id, order_date, gross_amount, net_amount, commission_percentage, commission_amount, settlement_amount, shipping_cost, discount_amount, installments, money_release_date, status, customer_name, customer_tax_id, currency_id, shipping_mode, payment_method, raw_data, order_tax_documents(id)")
        .gte("order_date", from_).lte("order_date", to_)
        .neq("status", "cancelled")
        .order("order_date", { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);

      setOrders(data || []);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { setPage(0); setSelected(null); }, [period]);
  useEffect(() => { fetchOrders(page); }, [fetchOrders, page]);

  const sync = async () => {
    setSyncing(true);
    setSyncMsg("Sincronizando...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-meli-orders");
      if (error) throw error;
      setSyncMsg(`✅ ${data?.synced || 0} órdenes guardadas`);
      fetchOrders(page);
    } catch (e: any) {
      setSyncMsg(`❌ ${e?.message || "Error"}`);
    } finally {
      setSyncing(false);
    }
  };

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
    setSyncMsg("");
  };

  const withDoc    = orders.filter(o => (o.order_tax_documents as any[])?.length > 0).length;
  const withoutDoc = orders.length - withDoc;
  const totalAmount = orders.reduce((s, o) => s + (o.gross_amount || 0), 0);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-semibold capitalize w-44 text-center">
              {format(new Date(period + "-01"), "MMMM yyyy", { locale: es })}
            </h1>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            {syncMsg && (
              <span className={`text-sm ${syncMsg.includes("❌") ? "text-red-500" : "text-green-600"}`}>
                {syncMsg}
              </span>
            )}
            <button
              onClick={sync}
              disabled={syncing || loading}
              className="flex items-center gap-2 px-4 py-2 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-40 text-yellow-900 font-medium rounded-lg text-sm"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync MercadoLibre
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: "Órdenes",       value: loading ? "—" : total,           sub: "en el período" },
            { label: "Total ventas",  value: loading ? "—" : CLP(totalAmount), sub: "bruto (página)" },
            { label: "Con documento", value: loading ? "—" : withDoc,          sub: "en esta página", color: "text-green-600" },
            { label: "Sin documento", value: loading ? "—" : withoutDoc,       sub: "en esta página",
              color: withoutDoc > 0 ? "text-red-600" : "text-green-600" },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="bg-white border rounded-lg p-4">
              <p className="text-xs text-slate-400 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color || "text-slate-800"}`}>{value}</p>
              <p className="text-xs text-slate-400 mt-1">{sub}</p>
            </div>
          ))}
        </div>

        {/* Orders table */}
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs text-slate-500">
                <th className="text-left px-4 py-3 font-medium">Orden ML</th>
                <th className="text-left px-4 py-3 font-medium">Fecha</th>
                <th className="text-left px-4 py-3 font-medium">Cliente</th>
                <th className="text-right px-4 py-3 font-medium">Monto</th>
                <th className="text-left px-4 py-3 font-medium">Estado</th>
                <th className="text-left px-4 py-3 font-medium">Boleta</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Cargando...
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-slate-400 text-sm">
                    Sin órdenes. Prueba Sync MercadoLibre.
                  </td>
                </tr>
              ) : orders.map(o => {
                const linked = (o.order_tax_documents as any[])?.length > 0;
                const isSelected = selected?.id === o.id;
                return (
                  <tr key={o.id} className={`border-b last:border-0 hover:bg-slate-50 ${isSelected ? "bg-slate-100" : ""}`}>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{o.order_id}</td>
                    <td className="px-4 py-2.5 text-slate-500 text-xs">{o.order_date?.slice(0, 10)}</td>
                    <td className="px-4 py-2.5 max-w-[160px] truncate">{o.customer_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{CLP(o.gross_amount)}</td>
                    <td className={`px-4 py-2.5 text-xs ${STATUS_COLOR[o.status] || "text-slate-500"}`}>
                      {STATUS_LABEL[o.status] || o.status}
                    </td>
                    <td className="px-4 py-2.5">
                      {linked
                        ? <span className="flex items-center gap-1 text-green-600 text-xs"><CheckCircle2 className="h-3.5 w-3.5" />Sí</span>
                        : <span className="flex items-center gap-1 text-slate-300 text-xs"><Clock className="h-3.5 w-3.5" />Pendiente</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setSelected(isSelected ? null : o)}
                        className={`${isSelected ? "text-slate-600" : "text-slate-300 hover:text-slate-500"}`}
                        title="Ver detalle"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-slate-400">
              Página {page + 1} de {totalPages} · {total} órdenes
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Anterior
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading}
                className="flex items-center gap-1 px-3 py-1.5 bg-white border rounded text-sm disabled:opacity-40 hover:bg-slate-50"
              >
                Siguiente <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

      </main>

      {selected && (
        <DetailPanel
          title={`Orden ML · ${selected.order_id}`}
          data={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
