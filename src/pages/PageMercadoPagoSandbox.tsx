import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Download } from "lucide-react";

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

const clp = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n || 0);

interface MpPayment {
  id: string;
  amount: number;
  date_approved: string;
  status: string;
  external_reference: string | null;
  matched: boolean;
}

export default function PageMercadoPagoSandbox() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    totalChecked: number; unmatchedCount: number; unmatchedAmount: number; payments: MpPayment[];
  } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
    setResult(null);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = periodRange(period);
      const { data, error: fnError } = await supabase.functions.invoke("check-orphan-payments", {
        body: { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` },
      });
      if (fnError) throw fnError;
      if (!data?.success) throw new Error(data?.error || "error desconocido");
      setResult({
        totalChecked: data.totalChecked, unmatchedCount: data.unmatchedCount,
        unmatchedAmount: data.unmatchedAmount, payments: data.payments ?? [],
      });
    } catch (e: any) {
      setError(e?.message || "No se pudo consultar MercadoPago");
    } finally {
      setLoading(false);
    }
  };

  const downloadJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.payments, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mercadopago-${period}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-4xl">

        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold capitalize w-44 text-center">{periodLabel(period)}</h1>
          <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white text-sm font-medium rounded-lg ml-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Cargar pagos de MercadoPago
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-6">
          Trae directo de MercadoPago (<code>/v1/payments/search</code>) los pagos aprobados del período —
          sin pasar por nuestras órdenes. Sirve para ver qué entró realmente y detectar pagos que el resto
          del pipeline nunca llegó a vincular a una venta.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-6">{error}</div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-white border rounded-lg p-4">
                <p className="text-xs text-slate-400 mb-1">Pagos aprobados</p>
                <p className="text-xl font-semibold">{result.totalChecked}</p>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <p className="text-xs text-slate-400 mb-1">Vinculados a una orden</p>
                <p className="text-xl font-semibold text-green-600">{result.totalChecked - result.unmatchedCount}</p>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <p className="text-xs text-slate-400 mb-1">Sin orden asociada</p>
                <p className={`text-xl font-semibold ${result.unmatchedCount > 0 ? "text-red-600" : "text-green-600"}`}>
                  {result.unmatchedCount}{result.unmatchedCount > 0 && ` · ${clp(result.unmatchedAmount)}`}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-slate-700">Pagos del período</p>
              <button onClick={downloadJson}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
                <Download className="h-3.5 w-3.5" /> Descargar JSON
              </button>
            </div>
            <div className="border rounded-lg overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2">Payment ID</th>
                    <th className="text-right px-3 py-2">Monto</th>
                    <th className="text-left px-3 py-2">Fecha aprobado</th>
                    <th className="text-left px-3 py-2">Referencia externa</th>
                    <th className="text-left px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {result.payments.length === 0 ? (
                    <tr><td colSpan={5} className="text-center text-slate-400 py-8">Sin pagos aprobados en este período</td></tr>
                  ) : result.payments.map(p => (
                    <tr key={p.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{p.id}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{clp(p.amount)}</td>
                      <td className="px-3 py-2 text-slate-500">{p.date_approved?.slice(0, 10)}</td>
                      <td className="px-3 py-2 text-slate-500">{p.external_reference || "—"}</td>
                      <td className="px-3 py-2">
                        {p.matched ? (
                          <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Vinculado</span>
                        ) : (
                          <span className="text-xs text-red-700 bg-red-50 px-2 py-0.5 rounded-full">Sin orden</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!result && !loading && !error && (
          <p className="text-center py-16 text-slate-400 text-sm">
            Toca "Cargar pagos de MercadoPago" para ver la data del período.
          </p>
        )}
      </main>
    </div>
  );
}
