import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, ExternalLink, CheckCircle2, Clock } from "lucide-react";

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
  confirmed:  "Pagada",
  paid:       "Pagada",
  delivered:  "Entregada",
  shipped:    "Enviada",
  pending:    "Pendiente",
  cancelled:  "Cancelada",
};

const STATUS_COLOR: Record<string, string> = {
  confirmed:  "text-green-600",
  paid:       "text-green-600",
  delivered:  "text-green-600",
  shipped:    "text-blue-600",
  pending:    "text-yellow-600",
  cancelled:  "text-slate-400",
};

export default function PageMeli() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodRange(period);
      const { data } = await supabase
        .from("orders")
        .select("id, order_id, order_date, gross_amount, status, customer_name, order_tax_documents(id)")
        .gte("order_date", from + "T00:00:00")
        .lte("order_date", to   + "T23:59:59")
        .order("order_date", { ascending: false })
        .limit(200);
      setOrders(data || []);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const sync = async () => {
    setSyncing(true);
    setSyncMsg("Sincronizando...");
    try {
      const { data, error } = await supabase.functions.invoke("sync-meli-orders");
      if (error) throw error;
      setSyncMsg(`✅ ${data?.synced || 0} órdenes guardadas`);
      fetchOrders();
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

  const total      = orders.length;
  const withDoc    = orders.filter(o => (o.order_tax_documents as any[])?.length > 0).length;
  const withoutDoc = total - withDoc;
  const totalAmount = orders.reduce((s, o) => s + (o.gross_amount || 0), 0);

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
            { label: "Órdenes",        value: loading ? "—" : total,                    sub: "en el período" },
            { label: "Total ventas",   value: loading ? "—" : CLP(totalAmount),         sub: "bruto" },
            { label: "Con documento",  value: loading ? "—" : withDoc,                  sub: "vinculadas a boleta", color: "text-green-600" },
            { label: "Sin documento",  value: loading ? "—" : withoutDoc,               sub: "sin boleta aún",
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
                return (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-slate-50">
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
                      <a
                        href={`https://www.mercadolibre.cl/ventas/${o.order_id}/detalle`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-slate-300 hover:text-slate-600"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && orders.length === 200 && (
          <p className="text-xs text-slate-400 mt-2 text-center">Mostrando los primeros 200 resultados</p>
        )}
      </main>
    </div>
  );
}
