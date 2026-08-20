import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

export type SyncSourceType = "meli" | "shopify" | "mercadopago" | "bsale";

export type SyncConnection = {
  source_type: SyncSourceType;
  connection_id: string;
  label: string;
  status: string;
};

type SourceRun = {
  id: string;
  source_type: SyncSourceType | null;
  source_connection_id: string | null;
  status: "queued" | "running" | "ok" | "error" | "cancelled";
  started_at: string;
  finished_at: string | null;
};

type Props = {
  period: string;
  canStart: boolean;
  busy: boolean;
  onStarted: () => Promise<void> | void;
  onConnectionsLoaded?: (connections: SyncConnection[]) => void;
};

const SOURCE_LABEL: Record<SyncSourceType, string> = {
  meli: "Ventas",
  shopify: "Ventas",
  mercadopago: "Pagos",
  bsale: "Documentos",
};

const RUN_STATUS: Record<SourceRun["status"], string> = {
  queued: "En cola",
  running: "Sincronizando",
  ok: "Completo",
  error: "Error",
  cancelled: "Cancelado",
};

export function SyncConnectionsPanel({
  period,
  canStart,
  busy,
  onStarted,
  onConnectionsLoaded,
}: Props) {
  const [connections, setConnections] = useState<SyncConnection[]>([]);
  const [runs, setRuns] = useState<SourceRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    const db = supabase as any;
    try {
      const { data: connectionRows, error: connectionError } = await db.rpc("list_sync_connections");
      if (connectionError) throw connectionError;
      const nextConnections = (connectionRows ?? []) as SyncConnection[];
      setConnections(nextConnections);
      onConnectionsLoaded?.(nextConnections);
      setAvailable(true);

      const { data: runRows, error: runError } = await db
        .from("sync_runs")
        .select("id, source_type, source_connection_id, status, started_at, finished_at")
        .eq("period", period)
        .eq("mode", "source")
        .order("started_at", { ascending: false })
        .limit(50);
      if (runError) throw runError;
      setRuns((runRows ?? []) as SourceRun[]);
    } catch (error) {
      // This branch can be merged before the migration is deployed. Keep the
      // existing Sync page usable until the backend metadata surface exists.
      console.warn("Sync connection metadata unavailable:", error);
      setAvailable(false);
      setConnections([]);
      setRuns([]);
      onConnectionsLoaded?.([]);
    } finally {
      setLoading(false);
    }
  }, [onConnectionsLoaded, period]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const latestByConnection = useMemo(() => {
    const map = new Map<string, SourceRun>();
    for (const run of runs) {
      if (!run.source_connection_id || map.has(run.source_connection_id)) continue;
      map.set(run.source_connection_id, run);
    }
    return map;
  }, [runs]);

  const startSource = async (connection: SyncConnection) => {
    if (!canStart || busy || starting) return;
    setStarting(connection.connection_id);
    try {
      const { data, error } = await supabase.functions.invoke("start-sync-run", {
        body: {
          period,
          mode: "source",
          source_type: connection.source_type,
          connection_id: connection.connection_id,
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (error) {
        let detail = error.message;
        try {
          const body = await (error as any)?.context?.json?.();
          detail = body?.error || body?.message || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      toast.success(data?.reused ? `${connection.label} ya estaba sincronizando` : `${connection.label}: Sync iniciado`);
      await Promise.resolve(onStarted());
      await refresh();
    } catch (error: any) {
      toast.error(error?.message || `No se pudo sincronizar ${connection.label}`);
    } finally {
      setStarting(null);
    }
  };

  const startReconcile = async () => {
    if (!canStart || busy || reconciling) return;
    setReconciling(true);
    try {
      const { data, error } = await supabase.functions.invoke("start-sync-run", {
        body: { period, mode: "reconcile_only" },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (error) {
        let detail = error.message;
        try {
          const body = await (error as any)?.context?.json?.();
          detail = body?.error || body?.message || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      toast.success(data?.reused ? "La conciliación ya estaba en curso" : "Conciliación iniciada");
      await Promise.resolve(onStarted());
    } catch (error: any) {
      toast.error(error?.message || "No se pudo iniciar la conciliación");
    } finally {
      setReconciling(false);
    }
  };

  if (!available) return null;

  return (
    <section className="bg-white border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">Fuentes conectadas</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Actualiza una conexión sin volver a ejecutar las demás fuentes.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-2", loading && "animate-spin")} />
          Actualizar
        </Button>
      </div>

      {loading && connections.length === 0 ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
      ) : connections.length === 0 ? (
        <div className="px-5 py-8 text-sm text-slate-400 text-center">No hay fuentes conectadas.</div>
      ) : (
        <div className="divide-y">
          {connections.map((connection) => {
            const latest = latestByConnection.get(connection.connection_id);
            const active = latest?.status === "queued" || latest?.status === "running";
            const isStarting = starting === connection.connection_id;
            return (
              <div key={`${connection.source_type}:${connection.connection_id}`} className="px-5 py-4 flex items-center gap-4">
                <div className={cn(
                  "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
                  active ? "bg-blue-50 text-blue-600" : connection.status === "connected" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400",
                )}>
                  {active ? <Loader2 className="h-4 w-4 animate-spin" /> : connection.status === "connected" ? <CheckCircle2 className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-900 truncate">{connection.label}</p>
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">{SOURCE_LABEL[connection.source_type]}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {latest
                      ? `${RUN_STATUS[latest.status]} · ${new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(latest.started_at))}`
                      : connection.status === "connected" ? "Conectado · aún sin Sync individual" : "Conexión no disponible"}
                  </p>
                </div>

                {canStart && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startSource(connection)}
                    disabled={busy || active || !!starting || connection.status !== "connected"}
                  >
                    {isStarting || active ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-2" />}
                    {active ? "Sincronizando" : "Sincronizar"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canStart && (
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center justify-between gap-4">
          <p className="text-xs text-slate-500">Conciliación relaciona lo ya cargado: venta ↔ pago ↔ DTE.</p>
          <Button variant="outline" size="sm" onClick={startReconcile} disabled={busy || reconciling || !!starting}>
            {reconciling ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-2" />}
            Reconciliar
          </Button>
        </div>
      )}
    </section>
  );
}
