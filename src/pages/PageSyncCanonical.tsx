import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/ui/button";
import {
  SyncConnectionsPanel,
  type SyncConnection,
  type SyncSourceType,
} from "@/components/sync/SyncConnectionsPanel";
import { cn } from "@/lib/utils";
import { chilePeriodNow } from "@/lib/chileDate";
import { supabase } from "@/integrations/supabase/client";

type StepKey =
  | "sync_meli_orders"
  | "sync_payments"
  | "sync_mp_cash" // historical runs only
  | "enrich_ruts"
  | "sync_shopify_orders"
  | "sync_mercadopago_payments"
  | "sync_bsale"
  | "reconcile";

type RunStatus = "queued" | "running" | "ok" | "error" | "cancelled";

type SyncRun = {
  id: string;
  period: string;
  mode: "full" | "source" | "reconcile_only";
  source_type: SyncSourceType | null;
  source_connection_id: string | null;
  trigger: "manual" | "cron" | "catchup";
  status: RunStatus;
  current_step: StepKey | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
  summary: any;
  error: any;
};

type StepAttempt = {
  id: string;
  sync_run_id: string;
  step: StepKey;
  source_type: SyncSourceType | null;
  source_connection_id: string | null;
  status: "running" | "ok" | "error";
  attempt: number;
  started_at: string;
  finished_at: string | null;
  detail: any;
};

const STEP_META: Record<StepKey, { label: string; description: string }> = {
  sync_meli_orders: { label: "Mercado Libre", description: "Órdenes comerciales" },
  sync_payments: { label: "Pagos MELI", description: "Detalle financiero de las ventas Mercado Libre" },
  sync_mp_cash: { label: "Caja MP", description: "Flujo legacy de caja Mercado Pago" },
  enrich_ruts: { label: "RUTs", description: "Datos de facturación Mercado Libre" },
  sync_shopify_orders: { label: "Shopify", description: "Órdenes comerciales Shopify" },
  sync_mercadopago_payments: { label: "Mercado Pago", description: "Pagos, devoluciones y contracargos" },
  sync_bsale: { label: "Bsale", description: "Boletas, facturas y notas" },
  reconcile: { label: "Conciliación", description: "Matching venta · pago · DTE" },
};

const statusLabel: Record<RunStatus, string> = {
  queued: "En cola",
  running: "Ejecutando",
  ok: "Completo",
  error: "Error",
  cancelled: "Cancelado",
};

const periodLabel = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return format(new Date(year, month - 1, 1), "MMMM yyyy", { locale: es });
};

const shiftPeriod = (period: string, delta: number) => {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

const duration = (run: SyncRun) => {
  if (!run.finished_at) return "En curso";
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)} min`;
};

function activityText(attempt: StepAttempt): string {
  const d = attempt.detail ?? {};
  if (attempt.status === "running") return "Procesando…";
  if (attempt.status === "error") return d?.error_detail || d?.error || d?.message || "La ejecución de este bloque falló";

  switch (attempt.step) {
    case "sync_meli_orders": {
      const synced = Number(d?.synced ?? d?.summary?.total_synced ?? 0);
      return `${synced.toLocaleString("es-CL")} órdenes procesadas${d?.partial ? " · quedan páginas por cargar" : ""}`;
    }
    case "sync_payments": {
      const linked = Number(d?.paymentsLinked ?? d?.linked ?? 0);
      const remaining = Number(d?.remaining ?? 0);
      return `${linked.toLocaleString("es-CL")} pagos vinculados${remaining > 0 ? ` · ${remaining.toLocaleString("es-CL")} pendientes` : ""}`;
    }
    case "sync_mp_cash": {
      const checked = d?.totalChecked ?? d?.checked ?? d?.paymentsChecked;
      return checked != null ? `${Number(checked).toLocaleString("es-CL")} pagos revisados` : "Caja Mercado Pago revisada";
    }
    case "enrich_ruts": {
      const enriched = Number(d?.enriched ?? 0);
      const remaining = Number(d?.remaining ?? 0);
      return `${enriched.toLocaleString("es-CL")} RUTs enriquecidos${remaining > 0 ? ` · ${remaining.toLocaleString("es-CL")} pendientes` : ""}`;
    }
    case "sync_shopify_orders": {
      const synced = Number(d?.synced ?? 0);
      const fetched = Number(d?.total ?? 0);
      return `${synced.toLocaleString("es-CL")} órdenes actualizadas${fetched ? ` · ${fetched.toLocaleString("es-CL")} leídas` : ""}${d?.partial ? " · continúa desde cursor" : ""}`;
    }
    case "sync_mercadopago_payments": {
      const fetched = Number(d?.totalFetched ?? 0);
      const approved = Number(d?.approvedCount ?? 0);
      const ingested = Number(d?.ingestedCount ?? 0);
      const reversals = Number(d?.reversalCount ?? 0);
      return `${fetched.toLocaleString("es-CL")} pagos revisados · ${approved.toLocaleString("es-CL")} aprobados · ${ingested.toLocaleString("es-CL")} actualizados${reversals ? ` · ${reversals.toLocaleString("es-CL")} devoluciones/contracargos` : ""}`;
    }
    case "sync_bsale": {
      const upserted = Number(d?.summary?.total_upserted ?? d?.total_upserted ?? 0);
      const available = d?.summary?.total_available ?? d?.total_available;
      return `${upserted.toLocaleString("es-CL")} documentos procesados${available != null ? ` de ${Number(available).toLocaleString("es-CL")}` : ""}${d?.partial ? " · continúa desde checkpoint" : ""}`;
    }
    case "reconcile":
      return "Conciliación del período completada";
  }
}

export default function PageSyncCanonical() {
  const [period, setPeriod] = useState(chilePeriodNow);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [attempts, setAttempts] = useState<StepAttempt[]>([]);
  const [connections, setConnections] = useState<SyncConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [canStart, setCanStart] = useState(false);
  const [roleLoading, setRoleLoading] = useState(true);

  const connectionLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of connections) map.set(connection.connection_id, connection.label);
    return map;
  }, [connections]);

  const activeRun = useMemo(
    () => runs.find((run) => run.status === "queued" || run.status === "running") ?? null,
    [runs],
  );
  const selectedRun = activeRun ?? runs[0] ?? null;
  const isActive = !!activeRun;

  const activity = useMemo(
    () => [...attempts].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()),
    [attempts],
  );

  const latestAttempt = activity[0] ?? null;

  const fetchRole = useCallback(async () => {
    setRoleLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc("current_org_role");
      if (error) throw error;
      setCanStart(["owner", "admin"].includes(String(data ?? "")));
    } catch {
      setCanStart(false);
    } finally {
      setRoleLoading(false);
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    const db = supabase as any;
    const { data: runRows, error: runError } = await db
      .from("sync_runs")
      .select("id, period, mode, source_type, source_connection_id, trigger, status, current_step, started_at, finished_at, updated_at, summary, error")
      .eq("period", period)
      .order("started_at", { ascending: false })
      .limit(20);
    if (runError) throw runError;

    const nextRuns = (runRows ?? []) as SyncRun[];
    setRuns(nextRuns);
    const current = nextRuns.find((run) => run.status === "queued" || run.status === "running") ?? nextRuns[0];

    if (!current) {
      setAttempts([]);
      return;
    }

    const { data: stepRows, error: stepError } = await db
      .from("pipeline_sync_runs")
      .select("id, sync_run_id, step, source_type, source_connection_id, status, attempt, started_at, finished_at, detail")
      .eq("sync_run_id", current.id)
      .order("started_at", { ascending: true });
    if (stepError) throw stepError;
    setAttempts((stepRows ?? []) as StepAttempt[]);
  }, [period]);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      await fetchRuns();
    } catch (error: any) {
      if (!silent) toast.error(error?.message || "No se pudo cargar Sync");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fetchRuns]);

  useEffect(() => { fetchRole(); }, [fetchRole]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const interval = window.setInterval(() => refresh(true), isActive ? 2500 : 10_000);
    return () => window.clearInterval(interval);
  }, [isActive, refresh]);

  const startSync = async () => {
    if (!canStart || starting || isActive) return;
    setStarting(true);
    try {
      const { data, error } = await supabase.functions.invoke("start-sync-run", {
        body: { period, mode: "full" },
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
      toast.success(data?.reused ? "Sync ya estaba en curso" : "Sync iniciado");
      await refresh(true);
    } catch (error: any) {
      toast.error(error?.message || "No se pudo iniciar Sync");
    } finally {
      setStarting(false);
    }
  };

  const runErrorLabel = selectedRun?.error?.stage === "enqueue"
    ? "No se pudo iniciar Sync:"
    : selectedRun?.error?.stage === "runner" && attempts.length === 0
      ? "No se pudo iniciar el runner:"
      : "Sync detenido:";

  const fullPlan: Array<{ source_type: SyncSourceType; connection_id: string }> =
    Array.isArray(selectedRun?.summary?.state?.full_connections)
      ? selectedRun.summary.state.full_connections
      : [];
  const fullIndex = Number(selectedRun?.summary?.state?.full_connection_index ?? 0);
  const fullDone = selectedRun?.status === "ok" ? fullPlan.length : Math.min(fullIndex, fullPlan.length);
  const fullProgress = fullPlan.length > 0 ? Math.round((fullDone / fullPlan.length) * 100) : 0;

  const runTitle = (run: SyncRun) => {
    if (run.mode === "source") {
      return run.source_connection_id
        ? connectionLabels.get(run.source_connection_id) ?? run.source_type ?? "Fuente"
        : run.source_type ?? "Fuente";
    }
    if (run.mode === "reconcile_only") return "Conciliación";
    return run.trigger === "cron" ? "Sync completo · automático" : "Sync completo";
  };

  const currentOperation = (() => {
    if (!selectedRun) return null;
    if (selectedRun.status === "ok") return "Proceso completado";
    if (selectedRun.status === "error" && attempts.length === 0) return "El runner no alcanzó a iniciar una fuente";
    if (latestAttempt) {
      const connection = latestAttempt.source_connection_id
        ? connectionLabels.get(latestAttempt.source_connection_id)
        : null;
      return connection
        ? `${connection} · ${STEP_META[latestAttempt.step]?.label ?? latestAttempt.step}`
        : STEP_META[latestAttempt.step]?.label ?? latestAttempt.step;
    }
    if (selectedRun.current_step) return STEP_META[selectedRun.current_step]?.label ?? selectedRun.current_step;
    return "Preparando ejecución";
  })();

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Nav />
      <main className="flex-1 min-w-0">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-slate-900">
                <Activity className="h-5 w-5" />
                <h1 className="text-2xl font-semibold">Sync</h1>
              </div>
              <p className="text-sm text-slate-500 mt-1">Sincronización y conciliación de las fuentes conectadas.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              Actualizar
            </Button>
          </div>

          <section className="bg-white border rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setPeriod((p) => shiftPeriod(p, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-40 text-center">
                  <p className="font-medium capitalize">{periodLabel(period)}</p>
                  <p className="text-xs text-slate-400">{period}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setPeriod((p) => shiftPeriod(p, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center gap-3">
                {isActive && (
                  <div className="text-xs text-slate-500 flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Sigue corriendo aunque salgas de esta página
                  </div>
                )}
                {!roleLoading && canStart && (
                  <Button onClick={startSync} disabled={starting || isActive}>
                    {starting || isActive ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                    {isActive ? "Sincronizando" : "Sincronizar todo"}
                  </Button>
                )}
              </div>
            </div>
          </section>

          <SyncConnectionsPanel
            period={period}
            canStart={canStart}
            busy={isActive || starting}
            onStarted={() => refresh(true)}
            onConnectionsLoaded={setConnections}
          />

          <section className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">Estado actual</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedRun ? `${runTitle(selectedRun)} · ${duration(selectedRun)}` : "Aún no hay ejecuciones para este período"}
                </p>
              </div>
              {selectedRun && (
                <span className={cn(
                  "text-xs px-2.5 py-1 rounded-full font-medium",
                  selectedRun.status === "ok" && "bg-emerald-50 text-emerald-700",
                  (selectedRun.status === "running" || selectedRun.status === "queued") && "bg-blue-50 text-blue-700",
                  selectedRun.status === "error" && "bg-red-50 text-red-700",
                  selectedRun.status === "cancelled" && "bg-slate-100 text-slate-600",
                )}>{statusLabel[selectedRun.status]}</span>
              )}
            </div>

            {!selectedRun ? (
              <div className="px-5 py-8 text-sm text-slate-400 text-center">Sin ejecuciones todavía.</div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="flex items-center gap-4">
                  <div className={cn(
                    "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
                    selectedRun.status === "ok" && "bg-emerald-50 text-emerald-600",
                    (selectedRun.status === "running" || selectedRun.status === "queued") && "bg-blue-50 text-blue-600",
                    selectedRun.status === "error" && "bg-red-50 text-red-600",
                    selectedRun.status === "cancelled" && "bg-slate-100 text-slate-400",
                  )}>
                    {selectedRun.status === "ok" ? <CheckCircle2 className="h-5 w-5" /> : selectedRun.status === "error" ? <XCircle className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{currentOperation}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {selectedRun.mode === "full"
                        ? fullPlan.length > 0
                          ? `${fullDone} de ${fullPlan.length} conexiones terminadas${fullIndex >= fullPlan.length && selectedRun.status !== "ok" ? " · conciliando" : ""}`
                          : "Preparando lista de conexiones"
                        : selectedRun.mode === "source"
                          ? "Solo esta conexión; no ejecuta otras fuentes ni concilia automáticamente."
                          : "Relacionando la información ya cargada."}
                    </p>
                  </div>
                </div>

                {selectedRun.mode === "full" && fullPlan.length > 0 && (
                  <div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${fullProgress}%` }} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-400">
                      {fullPlan.map((target, index) => (
                        <span key={`${target.source_type}:${target.connection_id}`} className={cn(index < fullDone && "text-emerald-600")}>
                          {connectionLabels.get(target.connection_id) ?? target.source_type}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {selectedRun?.status === "error" && selectedRun.error?.message && (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3 text-sm text-red-700">
              <span className="font-medium">{runErrorLabel}</span> {selectedRun.error.message}
            </div>
          )}

          <section className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-slate-500" />
                  <h2 className="font-medium">Actividad</h2>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">Registro persistente de lo que está cargando el run seleccionado.</p>
              </div>
              {isActive && <span className="text-xs text-blue-600 flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> En vivo</span>}
            </div>

            {!selectedRun ? (
              <div className="px-5 py-8 text-sm text-slate-400 text-center">Sin actividad todavía.</div>
            ) : activity.length === 0 ? (
              <div className="px-5 py-5 text-sm text-slate-500">
                {selectedRun.status === "queued" || selectedRun.status === "running"
                  ? "Run creado. Esperando al runner…"
                  : selectedRun.error?.message
                    ? `Sistema · ${selectedRun.error.message}`
                    : "Este run no alcanzó a registrar bloques de trabajo."}
              </div>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {activity.map((attempt) => {
                  const connectionLabel = attempt.source_connection_id ? connectionLabels.get(attempt.source_connection_id) : null;
                  return (
                    <div key={attempt.id} className="px-5 py-3 flex items-start gap-3 text-sm">
                      <span className="font-mono text-[11px] text-slate-400 w-16 shrink-0 pt-0.5">{format(new Date(attempt.started_at), "HH:mm:ss")}</span>
                      <div className={cn(
                        "mt-1 h-2 w-2 rounded-full shrink-0",
                        attempt.status === "ok" && "bg-emerald-500",
                        attempt.status === "running" && "bg-blue-500 animate-pulse",
                        attempt.status === "error" && "bg-red-500",
                      )} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-800">{connectionLabel || STEP_META[attempt.step]?.label || attempt.step}</span>
                          {connectionLabel && <span className="text-[10px] text-slate-400">{STEP_META[attempt.step]?.label}</span>}
                          {attempt.attempt > 1 && <span className="text-[10px] text-slate-400">intento {attempt.attempt}</span>}
                        </div>
                        <p className={cn("text-xs mt-0.5 break-words", attempt.status === "error" ? "text-red-600" : "text-slate-500")}>{activityText(attempt)}</p>
                      </div>
                      <span className={cn(
                        "text-[11px] shrink-0",
                        attempt.status === "ok" && "text-emerald-600",
                        attempt.status === "running" && "text-blue-600",
                        attempt.status === "error" && "text-red-600",
                      )}>{attempt.status === "ok" ? "Listo" : attempt.status === "running" ? "En curso" : "Error"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-medium">Historial</h2>
              <p className="text-xs text-slate-500 mt-0.5">Últimas ejecuciones del período seleccionado.</p>
            </div>
            {loading && runs.length === 0 ? (
              <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
            ) : runs.length === 0 ? (
              <div className="px-5 py-8 text-sm text-slate-400 text-center">Sin ejecuciones todavía.</div>
            ) : (
              <div className="divide-y">
                {runs.map((run) => (
                  <div key={run.id} className="px-5 py-3 flex items-center justify-between gap-4 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{runTitle(run)}</span>
                        <span className="text-xs text-slate-400">{format(new Date(run.started_at), "dd MMM · HH:mm", { locale: es })}</span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{duration(run)}</p>
                    </div>
                    <span className={cn(
                      "text-xs font-medium",
                      run.status === "ok" && "text-emerald-600",
                      (run.status === "running" || run.status === "queued") && "text-blue-600",
                      run.status === "error" && "text-red-600",
                      run.status === "cancelled" && "text-slate-500",
                    )}>{statusLabel[run.status]}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
