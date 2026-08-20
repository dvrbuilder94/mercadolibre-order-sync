import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { chilePeriodNow } from "@/lib/chileDate";
import { supabase } from "@/integrations/supabase/client";

const STEP_DEFS = [
  { key: "sync_meli_orders", label: "Mercado Libre", description: "Órdenes comerciales" },
  { key: "sync_payments", label: "Pagos", description: "Detalle financiero Mercado Pago" },
  { key: "sync_mp_cash", label: "Caja MP", description: "Pagos y movimientos sin asociar" },
  { key: "sync_bsale", label: "Bsale", description: "Boletas, facturas y notas" },
  { key: "enrich_ruts", label: "RUTs", description: "Datos de facturación" },
  { key: "reconcile", label: "Conciliación", description: "Matching venta · pago · DTE" },
] as const;

type StepKey = typeof STEP_DEFS[number]["key"];
type RunStatus = "queued" | "running" | "ok" | "error" | "cancelled";

type SyncRun = {
  id: string;
  period: string;
  mode: string;
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
  status: "running" | "ok" | "error";
  attempt: number;
  started_at: string;
  finished_at: string | null;
  detail: any;
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

const statusLabel: Record<RunStatus, string> = {
  queued: "En cola",
  running: "Ejecutando",
  ok: "Completo",
  error: "Error",
  cancelled: "Cancelado",
};

function metricText(step: StepKey, metrics: any): string {
  const m = metrics?.[step] ?? {};
  switch (step) {
    case "sync_meli_orders":
      return m.synced != null ? `${Number(m.synced).toLocaleString("es-CL")} órdenes procesadas` : "";
    case "sync_payments":
      return m.linked != null
        ? `${Number(m.linked).toLocaleString("es-CL")} pagos vinculados${m.remaining ? ` · ${m.remaining} pendientes` : ""}`
        : "";
    case "sync_mp_cash":
      return m.chunks ? `${m.chunks} cuenta${m.chunks === 1 ? "" : "s"} revisada${m.chunks === 1 ? "" : "s"}` : "";
    case "sync_bsale":
      return m.upserted != null
        ? `${Number(m.upserted).toLocaleString("es-CL")} documentos procesados${m.available ? ` de ${Number(m.available).toLocaleString("es-CL")}` : ""}`
        : "";
    case "enrich_ruts":
      return m.enriched != null
        ? `${Number(m.enriched).toLocaleString("es-CL")} RUTs enriquecidos${m.remaining ? ` · ${m.remaining} pendientes` : ""}`
        : "";
    case "reconcile":
      return m.completed ? "Conciliación final completada" : "";
  }
}

export default function PageSyncCanonical() {
  const [period, setPeriod] = useState(chilePeriodNow);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [attempts, setAttempts] = useState<StepAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [canStart, setCanStart] = useState(false);
  const [roleLoading, setRoleLoading] = useState(true);

  const activeRun = useMemo(
    () => runs.find((run) => run.status === "queued" || run.status === "running") ?? null,
    [runs],
  );
  const selectedRun = activeRun ?? runs[0] ?? null;
  const isActive = !!activeRun;

  const latestAttemptByStep = useMemo(() => {
    const result = new Map<StepKey, StepAttempt>();
    for (const attempt of attempts) result.set(attempt.step, attempt);
    return result;
  }, [attempts]);

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
      .select("id, period, mode, trigger, status, current_step, started_at, finished_at, updated_at, summary, error")
      .eq("period", period)
      .order("started_at", { ascending: false })
      .limit(12);
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
      .select("id, sync_run_id, step, status, attempt, started_at, finished_at, detail")
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

  useEffect(() => {
    fetchRole();
  }, [fetchRole]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => refresh(true), isActive ? 2500 : 10_000);
    return () => window.clearInterval(interval);
  }, [isActive, refresh]);

  const startSync = async () => {
    if (!canStart || starting || isActive) return;
    setStarting(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke("start-sync-run", {
        body: { period, mode: "full" },
        headers: { "Idempotency-Key": idempotencyKey },
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

  const currentStepIndex = selectedRun?.current_step
    ? STEP_DEFS.findIndex((step) => step.key === selectedRun.current_step)
    : -1;

  const stepState = (key: StepKey, index: number) => {
    if (!selectedRun) return "pending" as const;
    if (selectedRun.status === "ok") return "ok" as const;
    const latest = latestAttemptByStep.get(key);
    if (selectedRun.status === "error" && selectedRun.current_step === key) return "error" as const;
    if ((selectedRun.status === "running" || selectedRun.status === "queued") && selectedRun.current_step === key) {
      return "running" as const;
    }
    if (latest?.status === "error") return "error" as const;
    if (latest?.status === "ok" || (currentStepIndex >= 0 && index < currentStepIndex)) return "ok" as const;
    return "pending" as const;
  };

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
              <p className="text-sm text-slate-500 mt-1">
                Sincronización y conciliación de las fuentes conectadas.
              </p>
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
                    {starting || isActive ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    {isActive ? "Sincronizando" : "Sincronizar todo"}
                  </Button>
                )}
              </div>
            </div>
          </section>

          <section className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">Estado del período</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedRun
                    ? `${selectedRun.trigger === "manual" ? "Manual" : "Automático"} · ${statusLabel[selectedRun.status]} · ${duration(selectedRun)}`
                    : "Aún no hay ejecuciones para este período"}
                </p>
              </div>
              {selectedRun && (
                <span className={cn(
                  "text-xs px-2.5 py-1 rounded-full font-medium",
                  selectedRun.status === "ok" && "bg-emerald-50 text-emerald-700",
                  (selectedRun.status === "running" || selectedRun.status === "queued") && "bg-blue-50 text-blue-700",
                  selectedRun.status === "error" && "bg-red-50 text-red-700",
                  selectedRun.status === "cancelled" && "bg-slate-100 text-slate-600",
                )}>
                  {statusLabel[selectedRun.status]}
                </span>
              )}
            </div>

            <div className="divide-y">
              {STEP_DEFS.map((step, index) => {
                const status = stepState(step.key, index);
                const metric = metricText(step.key, selectedRun?.summary?.metrics);
                const latest = latestAttemptByStep.get(step.key);
                return (
                  <div key={step.key} className="px-5 py-4 flex items-center gap-4">
                    <div className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
                      status === "ok" && "bg-emerald-50 text-emerald-600",
                      status === "running" && "bg-blue-50 text-blue-600",
                      status === "error" && "bg-red-50 text-red-600",
                      status === "pending" && "bg-slate-100 text-slate-400",
                    )}>
                      {status === "ok" && <CheckCircle2 className="h-5 w-5" />}
                      {status === "running" && <Loader2 className="h-5 w-5 animate-spin" />}
                      {status === "error" && <XCircle className="h-5 w-5" />}
                      {status === "pending" && <Clock3 className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-900">{step.label}</p>
                        {latest?.attempt > 1 && (
                          <span className="text-[10px] text-slate-400">intento {latest.attempt}</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">{metric || step.description}</p>
                      {status === "error" && latest?.detail?.error && (
                        <p className="text-xs text-red-600 mt-1 truncate">{latest.detail.error}</p>
                      )}
                    </div>
                    <span className="text-xs text-slate-400 capitalize">
                      {status === "pending" ? "Pendiente" : status === "running" ? "En curso" : status === "ok" ? "Listo" : "Error"}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {selectedRun?.status === "error" && selectedRun.error?.message && (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3 text-sm text-red-700">
              <span className="font-medium">Sync detenido:</span> {selectedRun.error.message}
            </div>
          )}

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
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{run.trigger === "manual" ? "Manual" : run.trigger === "cron" ? "Automático" : "Catch-up"}</span>
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
                    )}>
                      {statusLabel[run.status]}
                    </span>
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
