import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { cn } from "@/lib/utils";
import {
  RefreshCw, Loader2, ChevronDown, Database, GitMerge,
  Clock, Radio, ExternalLink,
} from "lucide-react";
import {
  runHealth, relativeAgo, type HealthLevel, type RunLike,
} from "@/lib/systemHealth";

// ── Vista de salud / arquitectura (read-only) ──────────────────────────────
// "Mapa del sistema": muestra cómo entra y sale la data y qué motores hay,
// con un punto de salud por motor sacado de su última corrida REAL en
// pipeline_sync_runs. NO dispara nada (eso es /pipeline) — solo observa.

interface Run extends RunLike {
  id: string;
  period: string | null;
  step: string;
  detail: any;
}

// Resumen corto de qué hizo la última corrida de cada paso del cron.
function stepSummary(step: string, detail: any): string {
  if (!detail) return "";
  if (detail.error) return String(detail.error).slice(0, 60);
  switch (step) {
    case "sync_meli_orders": return `${detail.totalSynced ?? 0} órdenes`;
    case "sync_payments":    return `${detail.totalLinked ?? 0} pagos`;
    case "sync_bsale":       return `${detail.totalUpserted ?? 0} docs`;
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

const HEALTH_DOT: Record<HealthLevel, string> = {
  ok:      "bg-emerald-500",
  stale:   "bg-amber-400",
  error:   "bg-red-500",
  running: "bg-blue-500 animate-pulse",
  none:    "bg-slate-300",
  paused:  "bg-slate-300",
};

const HEALTH_TEXT: Record<HealthLevel, string> = {
  ok:      "operativo",
  stale:   "sin corrida reciente",
  error:   "con error",
  running: "ejecutando",
  none:    "sin corridas",
  paused:  "pausado",
};

interface EngineNode {
  title: string;
  subtitle?: string;   // qué hace / a qué tabla escribe
  health: HealthLevel;
  detail?: string;     // última corrida / estado
  dim?: boolean;       // motor dormido o externo (estilo tenue)
  to?: string;         // navegación opcional
}

function EngineCard({ node }: { node: EngineNode }) {
  const navigate = useNavigate();
  const clickable = !!node.to;
  return (
    <div
      onClick={clickable ? () => navigate(node.to!) : undefined}
      className={cn(
        "bg-white border rounded-lg p-3 flex-1 min-w-[140px]",
        node.dim && "opacity-70 border-dashed",
        clickable && "cursor-pointer hover:border-slate-400 hover:shadow-sm transition-all",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", HEALTH_DOT[node.health])} />
        <p className="text-sm font-medium text-slate-800 leading-tight flex-1">{node.title}</p>
        {clickable && <ExternalLink className="h-3 w-3 text-slate-300 shrink-0" />}
      </div>
      {node.subtitle && <p className="text-[11px] text-slate-400 leading-tight mt-1">{node.subtitle}</p>}
      <p className="text-[11px] text-slate-500 leading-tight mt-1">
        {node.detail ?? HEALTH_TEXT[node.health]}
      </p>
    </div>
  );
}

function Lane({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="w-full">
      <div className="flex items-baseline gap-2 mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        {hint && <p className="text-[10px] text-slate-300">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center py-2">
      <ChevronDown className="h-5 w-5 text-slate-300" />
    </div>
  );
}

export default function PageArquitectura() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [latestByStep, setLatestByStep] = useState<Record<string, Run>>({});
  const [lastCycle, setLastCycle] = useState<Run | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("pipeline_sync_runs" as any)
        .select("id, started_at, finished_at, period, step, status, detail")
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const runs = (data || []) as unknown as Run[];
      // Primera aparición de cada step = la más reciente (vienen ordenadas desc).
      const map: Record<string, Run> = {};
      for (const r of runs) if (!map[r.step]) map[r.step] = r;
      setLatestByStep(map);
      setLastCycle(runs[0] ?? null);
    } catch {
      setLatestByStep({});
      setLastCycle(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // Salud de un step a partir de su última corrida.
  const stepHealth = (step: string): HealthLevel => runHealth(latestByStep[step]);
  const stepDetail = (step: string): string | undefined => {
    const r = latestByStep[step];
    if (!r) return undefined;
    const sum = stepSummary(step, r.detail);
    return `${relativeAgo(r.finished_at ?? r.started_at)}${sum ? ` · ${sum}` : ""}`;
  };

  // ── Lanes ────────────────────────────────────────────────────────────────
  // Fuentes externas: su salud refleja el último sync que las leyó.
  const fuentes: EngineNode[] = [
    { title: "MercadoLibre", subtitle: "órdenes / ventas", health: stepHealth("sync_meli_orders"), detail: stepDetail("sync_meli_orders") },
    { title: "MercadoPago",  subtitle: "pagos · neto de fees", health: stepHealth("sync_payments"), detail: stepDetail("sync_payments") },
    { title: "Bsale (SII)",  subtitle: "documentos tributarios", health: stepHealth("sync_bsale"), detail: stepDetail("sync_bsale") },
    { title: "Banco · Fintoc", subtitle: "extracto bancario", health: "paused", dim: true },
  ];

  const ingesta: EngineNode[] = [
    { title: "Sync MeLi", subtitle: "→ orders", health: stepHealth("sync_meli_orders"), detail: stepDetail("sync_meli_orders") },
    { title: "Sync pagos", subtitle: "→ meli_payment_details", health: stepHealth("sync_payments"), detail: stepDetail("sync_payments") },
    { title: "Sync Bsale", subtitle: "→ tax_documents", health: stepHealth("sync_bsale"), detail: stepDetail("sync_bsale") },
    { title: "RUTs", subtitle: "→ orders.customer_tax_id", health: stepHealth("enrich_ruts"), detail: stepDetail("enrich_ruts") },
  ];

  const matching: EngineNode[] = [
    { title: "Conciliar docs", subtitle: "leg 1 · venta ↔ documento", health: stepHealth("reconcile"), detail: stepDetail("reconcile") },
    { title: "Conciliar banco", subtitle: "leg 3 · liquidación ↔ banco", health: "paused", dim: true, detail: "motor listo · espera Fintoc" },
  ];

  // Orquestador: salud del último ciclo (la corrida más reciente de cualquier paso).
  const cicloHealth = runHealth(lastCycle);
  const orquestacion: EngineNode[] = [
    {
      title: "cron-pipeline-sync",
      subtitle: "pg_cron · mes actual + anterior",
      health: cicloHealth,
      detail: lastCycle ? `último ciclo ${relativeAgo(lastCycle.started_at)}` : undefined,
    },
  ];

  const presentacion: EngineNode[] = [
    { title: "Resumen", subtitle: "KPIs de la cadena", health: "ok", to: "/resumen" },
    { title: "Ventas", subtitle: "órdenes + alertas", health: "ok", to: "/ventas" },
    { title: "Conciliación", subtitle: "leg 1 · documentos", health: "ok", to: "/conciliacion" },
    { title: "Liquidaciones", subtitle: "leg 2 · payout real", health: "ok", to: "/liquidaciones" },
  ];

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">

        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Radio className="h-5 w-5 text-slate-400" />
              Mapa del sistema
            </h1>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl">
              Cómo entra y sale la data, y qué motores la mueven. Cada punto de color es
              la <b>última corrida real</b> de ese motor — no dispara nada, solo observa.
              Para ejecutar pasos a mano, andá a <button onClick={() => navigate("/pipeline")} className="text-blue-600 hover:underline">Sincronización</button>.
            </p>
          </div>
          <button onClick={fetchRuns} disabled={loading}
            className="p-1.5 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40 shrink-0">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>

        {/* Leyenda */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 mb-6">
          {([
            ["ok", "operativo (corrida reciente)"],
            ["stale", "sin corrida en >24h"],
            ["error", "última corrida con error"],
            ["running", "ejecutando ahora"],
            ["none", "nunca corrió"],
            ["paused", "pausado / sin fuente"],
          ] as [HealthLevel, string][]).map(([h, t]) => (
            <span key={h} className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", HEALTH_DOT[h])} /> {t}
            </span>
          ))}
        </div>

        {loading && Object.keys(latestByStep).length === 0 ? (
          <p className="text-sm text-slate-400 flex items-center gap-2 py-12">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando estado de los motores...
          </p>
        ) : (
          <div className="space-y-0">
            <Lane label="Fuentes externas" hint="APIs de origen">
              {fuentes.map((n) => <EngineCard key={n.title} node={n} />)}
            </Lane>

            <Connector />

            <Lane label="Ingesta · sync" hint="traen y normalizan la data">
              {ingesta.map((n) => <EngineCard key={n.title} node={n} />)}
            </Lane>

            <Connector />

            <Lane label="Matching · conciliación" hint="cruzan las verdades de la cadena">
              {matching.map((n) => <EngineCard key={n.title} node={n} />)}
            </Lane>

            <Connector />

            <Lane label="Orquestación · cron" hint="corre los pasos en orden, solo / cada pocas horas">
              {orquestacion.map((n) => <EngineCard key={n.title} node={n} />)}
            </Lane>

            <Connector />

            <Lane label="Presentación" hint="dónde se ve el resultado">
              {presentacion.map((n) => <EngineCard key={n.title} node={n} />)}
            </Lane>
          </div>
        )}

        {/* Pie: cómo leer el mapa */}
        <div className="mt-8 grid sm:grid-cols-3 gap-3 text-[11px] text-slate-500">
          <div className="bg-white border rounded-lg p-3">
            <p className="font-medium text-slate-700 flex items-center gap-1.5 mb-1">
              <Database className="h-3.5 w-3.5 text-slate-400" /> Fuente de la salud
            </p>
            Cada punto sale de <code className="text-slate-600">pipeline_sync_runs</code>,
            la bitácora real del cron. Si un motor nunca corrió, queda gris — no se inventa un estado.
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="font-medium text-slate-700 flex items-center gap-1.5 mb-1">
              <GitMerge className="h-3.5 w-3.5 text-slate-400" /> Legs de la cadena
            </p>
            Leg 1 (venta ↔ documento) y leg 2 (venta ↔ payout) están activos.
            Leg 3 (liquidación ↔ banco) tiene el motor listo pero espera reactivar Fintoc.
          </div>
          <div className="bg-white border rounded-lg p-3">
            <p className="font-medium text-slate-700 flex items-center gap-1.5 mb-1">
              <Clock className="h-3.5 w-3.5 text-slate-400" /> Cobertura del cron
            </p>
            El cron solo re-procesa mes actual + anterior. Por eso una venta vieja sin
            confirmar puede quedar "colgada" — eso se ve por orden en Ventas/Liquidaciones.
          </div>
        </div>

      </main>
    </div>
  );
}
