// Salud de cada motor del sistema a partir de su última corrida REAL en
// pipeline_sync_runs. No inventa estados: si un motor nunca corrió devuelve
// "none" (punto gris), no un falso "ok". El color sale del status real y la
// antigüedad de la corrida sale del timestamp real.

export type HealthLevel = "ok" | "stale" | "error" | "running" | "none" | "paused";

export interface RunLike {
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
}

// Una corrida "ok" más vieja que esto se considera rancia (ámbar): el cron
// corre cada pocas horas, así que pasado un día sin corrida exitosa algo anda
// mal aunque la última haya sido "ok".
export const STALE_HOURS = 24;

export function hoursSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

export function runHealth(run: RunLike | null | undefined, now: Date = new Date()): HealthLevel {
  if (!run) return "none";
  if (run.status === "error") return "error";
  if (run.status === "running") return "running";
  if (run.status === "ok") {
    const ref = run.finished_at ?? run.started_at;
    const h = hoursSince(ref, now);
    if (h === null) return "ok";
    return h > STALE_HOURS ? "stale" : "ok";
  }
  return "none";
}

// "hace 2h" / "hace 3d" / "hace 12min" a partir de un timestamp real.
export function relativeAgo(iso: string | null, now: Date = new Date()): string {
  const h = hoursSince(iso, now);
  if (h === null) return "—";
  if (h < 0) return "ahora";
  if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))}min`;
  if (h < 24) return `hace ${Math.round(h)}h`;
  return `hace ${Math.round(h / 24)}d`;
}
