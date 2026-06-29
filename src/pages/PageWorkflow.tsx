import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  RefreshCw, Loader2, Play, ChevronLeft, ChevronRight,
  Database, GitMerge, FileText, Users, Banknote, Eye,
  Workflow as WorkflowIcon, CheckCircle2, AlertTriangle, XCircle, Clock,
} from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  runHealth, relativeAgo, type HealthLevel, type RunLike,
} from "@/lib/systemHealth";
import { chileMonthUnixRange } from "@/lib/chileDate";

// ── Workflow: unifica "Mapa del sistema" + "Sincronización" en un timeline
// vertical. Cada paso muestra salud real (de pipeline_sync_runs) y un drawer
// con últimas corridas + botón "Ejecutar ahora". No reemplaza /pipeline (queda
// como modo avanzado con raw extractor y checkpoint manual de Bsale).

interface Run extends RunLike {
  id: string;
  period: string | null;
  step: string;
  detail: any;
}

type StepKey =
  | "sync_meli_orders" | "sync_payments" | "sync_bsale"
  | "enrich_ruts" | "reconcile";

interface StepDef {
  key: StepKey;
  title: string;
  subtitle: string;
  icon: typeof Database;
  fn: string;
  bodyBuilder: (period: string) => Record<string, unknown>;
  output: string;
}

const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};
const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

const STEPS: StepDef[] = [
  {
    key: "sync_meli_orders",
    title: "Sync órdenes MercadoLibre",
    subtitle: "Trae las ventas del período desde la API de MELI",
    icon: Database,
    fn: "sync-meli-orders",
    output: "→ orders",
    bodyBuilder: (p) => {
      const { from, to } = periodRange(p);
      return { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59`, max_pages: 50 };
    },
  },
  {
    key: "sync_payments",
    title: "Sync pagos MercadoPago",
    subtitle: "Trae bruto, fees y neto exacto de cada pago",
    icon: Banknote,
    fn: "sync-meli-payment-details",
    output: "→ meli_payment_details",
    bodyBuilder: (p) => {
      const { from, to } = periodRange(p);
      return { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59`, limit: 50 };
    },
  },
  {
    key: "sync_bsale",
    title: "Sync documentos Bsale",
    subtitle: "Trae boletas, facturas y notas de crédito del SII",
    icon: FileText,
    fn: "sync-bsale-docs",
    output: "→ tax_documents",
    bodyBuilder: (p) => {
      const { from, to } = chileMonthUnixRange(p);
      return { date_from: from, date_to: to, max_pages: 20 };
    },
  },
  {
    key: "enrich_ruts",
    title: "Enriquecer RUTs",
    subtitle: "Completa el RUT del comprador en órdenes con factura",
    icon: Users,
    fn: "enrich-meli-billing",
    output: "→ orders.customer_tax_id",
    bodyBuilder: () => ({ limit: 100 }),
  },
  {
    key: "reconcile",
    title: "Conciliar venta ↔ documento",
    subtitle: "Match exacto, por pack, consolidado y por score",
    icon: GitMerge,
    fn: "auto-reconcile",
    output: "→ order_tax_documents",
    bodyBuilder: (p) => {
      const { from, to } = periodRange(p);
      return { date_from: `${from}T00:00:00`, date_to: `${to}T23:59:59` };
    },
  },
];

const HEALTH_BADGE: Record<HealthLevel, { dot: string; ring: string; label: string; Icon: typeof CheckCircle2 }> = {
  ok:      { dot: "bg-emerald-500", ring: "ring-emerald-100", label: "operativo", Icon: CheckCircle2 },
  stale:   { dot: "bg-amber-400",   ring: "ring-amber-100",   label: "sin corrida reciente", Icon: Clock },
  error:   { dot: "bg-red-500",     ring: "ring-red-100",     label: "con error", Icon: XCircle },
  running: { dot: "bg-blue-500 animate-pulse", ring: "ring-blue-100", label: "ejecutando", Icon: Loader2 },
  none:    { dot: "bg-slate-300",   ring: "ring-slate-100",   label: "sin corridas", Icon: AlertTriangle },
  paused:  { dot: "bg-slate-300",   ring: "ring-slate-100",   label: "pausado", Icon: AlertTriangle },
};

function summarize(step: string, detail: any): string {
  if (!detail) return "";
  if (detail.error) return String(detail.error).slice(0, 80);
  switch (step) {
    case "sync_meli_orders": return `${detail.totalSynced ?? detail.synced ?? 0} órdenes`;
    case "sync_payments":    return `${detail.totalLinked ?? detail.paymentsLinked ?? 0} pagos vinculados`;
    case "sync_bsale":       return `${detail.totalUpserted ?? detail?.summary?.total_upserted ?? 0} docs`;
    case "enrich_ruts":      return `${detail.totalEnriched ?? 0} RUTs`;
    case "reconcile": {
      const s3 = detail.stage3_order_taxdoc || {};
      const n = (s3.hard_linked ?? 0) + (s3.hard_linked_pack_id_orders ?? 0)
        + (s3.auto_consolidated_orders ?? s3.auto_consolidated ?? 0) + (s3.auto_linked ?? 0);
      return `+${n} vínculos`;
    }
    default: return "";
  }
}

export default function PageWorkflow() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [runsByStep, setRunsByStep] = useState<Record<string, Run[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [drawerStep, setDrawerStep] = useState<StepDef | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const addLog = (msg: string) => {
    const t = format(new Date(), "HH:mm:ss");
    setLog(prev => [`${t}  ${msg}`, ...prev].slice(0, 200));
  };

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("pipeline_sync_runs" as any)
        .select("id, started_at, finished_at, period, step, status, detail")
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const map: Record<string, Run[]> = {};
      for (const r of (data || []) as unknown as Run[]) {
        if (!map[r.step]) map[r.step] = [];
        map[r.step].push(r);
      }
      setRunsByStep(map);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const errorDetail = async (e: any): Promise<string> => {
    try {
      const body = await e?.context?.json?.();
      if (body?.error || body?.message) return body.error || body.message;
    } catch { /* */ }
    return e?.message || "error desconocido";
  };

  const runStep = async (step: StepDef): Promise<boolean> => {
    setRunning(r => ({ ...r, [step.key]: true }));
    addLog(`› ${step.title}...`);
    try {
      const { data, error } = await supabase.functions.invoke(step.fn, {
        body: step.bodyBuilder(period),
      });
      if (error) throw error;
      const sum = summarize(step.key, data);
      addLog(`✅ ${step.title}: ${sum || "ok"}`);
      return true;
    } catch (e: any) {
      addLog(`❌ ${step.title}: ${await errorDetail(e)}`);
      return false;
    } finally {
      setRunning(r => ({ ...r, [step.key]: false }));
      fetchRuns();
    }
  };

  const runAll = async () => {
    setRunningAll(true);
    addLog(`▶ Pipeline completo · ${periodLabel(period)}`);
    for (const step of STEPS) {
      const ok = await runStep(step);
      if (!ok) {
        addLog(`⚠️ Cadena detenida en "${step.title}"`);
        break;
      }
    }
    setRunningAll(false);
  };

  const stepHealth = (key: string): HealthLevel => runHealth(runsByStep[key]?.[0]);
  const stepLast = (key: string): Run | undefined => runsByStep[key]?.[0];

  const presentation = [
    { to: "/resumen",      label: "Resumen mensual" },
    { to: "/ventas",       label: "Ventas + alertas" },
    { to: "/conciliacion", label: "Conciliación de docs" },
    { to: "/tesoreria",    label: "Tesorería · payout" },
  ];

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-4xl">

        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <WorkflowIcon className="h-5 w-5 text-slate-400" />
              Workflow
            </h1>
            <p className="text-sm text-slate-500 mt-1 max-w-xl">
              Cadena completa de datos: <b>fuente → ingesta → match → vista</b>.
              Cada paso muestra su última corrida real y se puede disparar a mano.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchRuns} disabled={loading}
              className="p-1.5 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Period + run all */}
        <div className="bg-white border rounded-lg p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => {
              const [y, m] = period.split("-").map(Number);
              setPeriod(format(new Date(y, m - 2, 1), "yyyy-MM"));
            }} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-medium capitalize min-w-[140px] text-center">{periodLabel(period)}</p>
            <button onClick={() => {
              const [y, m] = period.split("-").map(Number);
              setPeriod(format(new Date(y, m, 1), "yyyy-MM"));
            }} className="p-1.5 hover:bg-slate-100 rounded">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={runAll}
            disabled={runningAll || Object.values(running).some(Boolean)}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm rounded-md hover:bg-slate-700 disabled:opacity-50"
          >
            {runningAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Ejecutar pipeline completo
          </button>
        </div>

        {/* Timeline */}
        <div className="relative">
          {/* línea vertical */}
          <div className="absolute left-[19px] top-2 bottom-2 w-px bg-slate-200" />

          {/* Fuente externa (read-only) */}
          <TimelineRow
            icon={Database}
            tone="muted"
            health="ok"
            title="Fuentes externas"
            subtitle="MercadoLibre · MercadoPago · Bsale (read-only)"
            right={<span className="text-xs text-slate-400">origen</span>}
          />

          {STEPS.map((step) => {
            const health = stepHealth(step.key);
            const last = stepLast(step.key);
            const isRunning = running[step.key];
            return (
              <TimelineRow
                key={step.key}
                icon={step.icon}
                health={isRunning ? "running" : health}
                title={step.title}
                subtitle={step.subtitle}
                meta={last
                  ? `${relativeAgo(last.finished_at ?? last.started_at)} · ${summarize(step.key, last.detail) || HEALTH_BADGE[health].label}`
                  : "nunca corrió"}
                output={step.output}
                onOpenDrawer={() => setDrawerStep(step)}
                right={
                  <button
                    onClick={(e) => { e.stopPropagation(); runStep(step); }}
                    disabled={isRunning || runningAll}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md hover:bg-slate-50 disabled:opacity-40 bg-white"
                  >
                    {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Ejecutar
                  </button>
                }
              />
            );
          })}

          {/* Vista final */}
          <TimelineRow
            icon={Eye}
            tone="muted"
            health="ok"
            title="Vistas en la app"
            subtitle="dónde se ve el resultado de la cadena"
            right={
              <div className="flex flex-wrap gap-1 justify-end max-w-xs">
                {presentation.map(p => (
                  <button key={p.to} onClick={() => navigate(p.to)}
                    className="text-xs px-2 py-1 border rounded hover:bg-slate-50 text-slate-600">
                    {p.label}
                  </button>
                ))}
              </div>
            }
          />
        </div>

        {/* Log live */}
        {log.length > 0 && (
          <div className="mt-6 bg-slate-900 text-slate-100 rounded-lg p-4 font-mono text-[11px] max-h-60 overflow-auto">
            {log.map((l, i) => <div key={i} className="leading-relaxed">{l}</div>)}
          </div>
        )}

        <p className="mt-4 text-[11px] text-slate-400">
          ¿Necesitás raw extractor, checkpoint manual de Bsale o reset de vínculos?
          Activá Modo avanzado y andá a{" "}
          <button onClick={() => navigate("/pipeline")} className="text-blue-600 hover:underline">
            Sync avanzada
          </button>.
        </p>

        {/* Drawer por paso */}
        <Sheet open={!!drawerStep} onOpenChange={(o) => !o && setDrawerStep(null)}>
          <SheetContent className="sm:max-w-md overflow-y-auto">
            {drawerStep && (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <drawerStep.icon className="h-4 w-4 text-slate-400" />
                    {drawerStep.title}
                  </SheetTitle>
                  <SheetDescription>
                    {drawerStep.subtitle}
                    <br />
                    <code className="text-[10px] text-slate-400">{drawerStep.fn}</code>
                    <span className="text-[10px] text-slate-400"> · {drawerStep.output}</span>
                  </SheetDescription>
                </SheetHeader>

                <button
                  onClick={() => runStep(drawerStep)}
                  disabled={running[drawerStep.key]}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm rounded-md hover:bg-slate-700 disabled:opacity-50"
                >
                  {running[drawerStep.key]
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Play className="h-4 w-4" />}
                  Ejecutar ahora · {periodLabel(period)}
                </button>

                <p className="mt-6 mb-2 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                  Últimas corridas
                </p>
                <div className="space-y-2">
                  {(runsByStep[drawerStep.key] || []).slice(0, 12).map((r) => {
                    const h = runHealth(r);
                    const B = HEALTH_BADGE[h];
                    return (
                      <div key={r.id} className="border rounded-md p-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full", B.dot)} />
                            <span className="font-medium">{relativeAgo(r.finished_at ?? r.started_at)}</span>
                            {r.period && <span className="text-slate-400">· {r.period}</span>}
                          </div>
                          <span className="text-slate-400">{r.status}</span>
                        </div>
                        <p className="text-slate-500 mt-1">{summarize(r.step, r.detail) || "—"}</p>
                      </div>
                    );
                  })}
                  {!runsByStep[drawerStep.key]?.length && (
                    <p className="text-xs text-slate-400">Sin corridas registradas.</p>
                  )}
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

      </main>
    </div>
  );
}

// ── Subcomponente ───────────────────────────────────────────────────────────
function TimelineRow({
  icon: Icon, health, title, subtitle, meta, output, right, onOpenDrawer, tone,
}: {
  icon: typeof Database;
  health: HealthLevel;
  title: string;
  subtitle: string;
  meta?: string;
  output?: string;
  right?: React.ReactNode;
  onOpenDrawer?: () => void;
  tone?: "muted";
}) {
  const B = HEALTH_BADGE[health];
  const clickable = !!onOpenDrawer;
  return (
    <div className="relative pl-12 pb-3">
      {/* nodo */}
      <div className={cn(
        "absolute left-2 top-3 h-6 w-6 rounded-full bg-white border-2 flex items-center justify-center ring-4",
        B.ring,
        health === "error" ? "border-red-300" :
        health === "ok" ? "border-emerald-300" :
        health === "running" ? "border-blue-300" :
        health === "stale" ? "border-amber-300" : "border-slate-200",
      )}>
        <span className={cn("h-2 w-2 rounded-full", B.dot)} />
      </div>

      <div
        onClick={onOpenDrawer}
        className={cn(
          "bg-white border rounded-lg p-3 flex items-center gap-3",
          clickable && "cursor-pointer hover:border-slate-300 hover:shadow-sm transition-all",
          tone === "muted" && "bg-slate-50/50 border-dashed",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", tone === "muted" ? "text-slate-300" : "text-slate-500")} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 leading-tight">{title}</p>
          <p className="text-[11px] text-slate-500 leading-tight mt-0.5">{subtitle}</p>
          {meta && (
            <p className="text-[10px] text-slate-400 mt-1">
              {meta}{output && <span className="ml-1">· <code>{output}</code></span>}
            </p>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
    </div>
  );
}