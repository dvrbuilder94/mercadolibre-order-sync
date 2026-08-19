import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileJson, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Nav } from "@/components/Nav";
import { supabase } from "@/integrations/supabase/client";

interface MeliDump {
  source?: string;
  period?: string;
  seller_id?: string | number;
  orders?: any[];
}

interface LoadedFile {
  name: string;
  period: string;
  sellerId: string | null;
  orders: any[];
}

export default function PageImportMeliBackup() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [connectedSeller, setConnectedSeller] = useState<string | null>(null);
  const [result, setResult] = useState<{ synced: number; preserved: number } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        navigate("/auth");
        return;
      }
      const { data } = await supabase
        .from("meli_accounts")
        .select("seller_id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setConnectedSeller(data?.seller_id ? String(data.seller_id) : null);
      setChecking(false);
    });
  }, [navigate]);

  const combined = useMemo(() => {
    const byId = new Map<string, any>();
    let input = 0;
    let payments = 0;
    const periods = new Set<string>();
    const sellers = new Set<string>();

    for (const file of files) {
      periods.add(file.period);
      if (file.sellerId) sellers.add(file.sellerId);
      for (const order of file.orders) {
        input += 1;
        payments += Array.isArray(order?.payments) ? order.payments.length : 0;
        if (order?.id != null) byId.set(String(order.id), order);
      }
    }

    return {
      input,
      uniqueOrders: [...byId.values()],
      duplicates: input - byId.size,
      payments,
      periods: [...periods].sort(),
      sellers: [...sellers],
    };
  }, [files]);

  const handleFiles = async (selected: FileList | null) => {
    if (!selected?.length) return;
    setResult(null);
    try {
      const parsed: LoadedFile[] = [];
      for (const file of Array.from(selected)) {
        const text = await file.text();
        const dump = JSON.parse(text) as MeliDump;
        if (dump.source !== "mercadolibre" || !Array.isArray(dump.orders)) {
          throw new Error(`${file.name}: no parece un respaldo válido de Mercado Libre`);
        }
        if (dump.orders.some((order) => order?.id == null || !order?.date_created)) {
          throw new Error(`${file.name}: contiene órdenes sin id o date_created`);
        }
        parsed.push({
          name: file.name,
          period: dump.period || "sin período",
          sellerId: dump.seller_id != null ? String(dump.seller_id) : null,
          orders: dump.orders,
        });
      }
      setFiles(parsed);
    } catch (error) {
      setFiles([]);
      toast.error(error instanceof Error ? error.message : "No se pudo leer el respaldo");
    }
  };

  const sellerMismatch = combined.sellers.length > 1 || (
    connectedSeller != null && combined.sellers.length === 1 && combined.sellers[0] !== connectedSeller
  );

  const importData = async () => {
    if (combined.uniqueOrders.length === 0 || sellerMismatch || loading) return;
    setLoading(true);
    setResult(null);
    let synced = 0;
    let preserved = 0;

    try {
      const sellerId = combined.sellers[0] || connectedSeller;
      for (let i = 0; i < combined.uniqueOrders.length; i += 100) {
        const chunk = combined.uniqueOrders.slice(i, i + 100);
        const { data, error } = await supabase.functions.invoke("import-meli-backup", {
          body: { orders: chunk, seller_id: sellerId },
        });
        if (error || !data?.success) {
          throw new Error(data?.error || error?.message || `Falló el lote ${Math.floor(i / 100) + 1}`);
        }
        synced += Number(data.synced || 0);
        preserved += Number(data.preserved_exact || 0);
      }
      setResult({ synced, preserved });
      toast.success(`${synced} órdenes MELI importadas/actualizadas`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falló la importación");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-8">
          <p className="text-sm font-medium text-muted-foreground">Configuración · Recuperación histórica</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Importar respaldo Mercado Libre</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Carga exportaciones JSON de MELI sin modificar OAuth. Quadra deduplica por order_id y escribe en la misma tabla orders usada por la sincronización normal.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-muted p-2"><FileJson className="h-5 w-5" /></div>
            <div className="flex-1">
              <h2 className="font-semibold">1. Selecciona tus JSON MELI</h2>
              <p className="mt-1 text-sm text-muted-foreground">Puedes seleccionar mayo y junio juntos. Los archivos no se suben a GitHub.</p>
              <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">
                <Upload className="h-4 w-4" /> Seleccionar archivos
                <input className="hidden" type="file" accept="application/json,.json" multiple onChange={(e) => handleFiles(e.target.files)} />
              </label>
            </div>
          </div>
        </div>

        {files.length > 0 && (
          <div className="mt-6 rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="font-semibold">2. Diagnóstico antes de importar</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Registros leídos" value={combined.input} />
              <Metric label="Órdenes únicas" value={combined.uniqueOrders.length} />
              <Metric label="Duplicados eliminados" value={combined.duplicates} />
              <Metric label="Pagos embebidos" value={combined.payments} />
            </div>

            <div className="mt-5 space-y-2 text-sm">
              <p><span className="text-muted-foreground">Períodos:</span> {combined.periods.join(", ")}</p>
              <p><span className="text-muted-foreground">Seller del respaldo:</span> {combined.sellers.join(", ") || "no informado"}</p>
              <p><span className="text-muted-foreground">Seller conectado en Quadra:</span> {checking ? "revisando…" : connectedSeller || "sin cuenta conectada"}</p>
            </div>

            {sellerMismatch && (
              <div className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                El seller del respaldo no coincide con la cuenta MELI conectada. La importación queda bloqueada para evitar cargar datos en la cuenta equivocada.
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={importData}
                disabled={loading || checking || sellerMismatch || combined.uniqueOrders.length === 0 || !connectedSeller}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {loading ? "Importando…" : `Importar ${combined.uniqueOrders.length} órdenes a Quadra`}
              </button>
              <span className="text-xs text-muted-foreground">No borra órdenes existentes. Si una orden ya tiene datos financieros exactos, los preserva.</span>
            </div>
          </div>
        )}

        {result && (
          <div className="mt-6 flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
            <div>
              <p className="font-medium">Importación terminada</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {result.synced} órdenes procesadas. {result.preserved} ya tenían datos financieros exactos y fueron preservadas.
              </p>
              <button onClick={() => navigate("/ventas")} className="mt-3 text-sm font-medium text-primary hover:underline">Ver ventas importadas →</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString("es-CL")}</p>
    </div>
  );
}
