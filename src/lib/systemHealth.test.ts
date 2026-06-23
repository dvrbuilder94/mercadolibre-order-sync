import { describe, it, expect } from "vitest";
import { runHealth, relativeAgo, hoursSince, STALE_HOURS } from "./systemHealth";

const NOW = new Date("2026-06-23T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

describe("runHealth", () => {
  it("sin corrida es 'none' (no inventa un ok)", () => {
    expect(runHealth(null, NOW)).toBe("none");
    expect(runHealth(undefined, NOW)).toBe("none");
  });

  it("status error es 'error' sin importar la fecha", () => {
    expect(runHealth({ status: "error", started_at: hoursAgo(1), finished_at: hoursAgo(1) }, NOW)).toBe("error");
  });

  it("status running es 'running'", () => {
    expect(runHealth({ status: "running", started_at: hoursAgo(0.1), finished_at: null }, NOW)).toBe("running");
  });

  it("ok reciente es 'ok'", () => {
    expect(runHealth({ status: "ok", started_at: hoursAgo(3), finished_at: hoursAgo(3) }, NOW)).toBe("ok");
  });

  it("ok más viejo que STALE_HOURS es 'stale'", () => {
    expect(runHealth({ status: "ok", started_at: hoursAgo(STALE_HOURS + 1), finished_at: hoursAgo(STALE_HOURS + 1) }, NOW)).toBe("stale");
  });

  it("usa finished_at si existe, si no started_at", () => {
    expect(runHealth({ status: "ok", started_at: hoursAgo(50), finished_at: null }, NOW)).toBe("stale");
    expect(runHealth({ status: "ok", started_at: hoursAgo(50), finished_at: hoursAgo(2) }, NOW)).toBe("ok");
  });

  it("status desconocido cae en 'none'", () => {
    expect(runHealth({ status: "whatever", started_at: hoursAgo(1), finished_at: hoursAgo(1) }, NOW)).toBe("none");
  });
});

describe("relativeAgo / hoursSince", () => {
  it("null devuelve guion", () => {
    expect(relativeAgo(null, NOW)).toBe("—");
    expect(hoursSince(null, NOW)).toBe(null);
  });

  it("minutos / horas / días", () => {
    expect(relativeAgo(hoursAgo(0.5), NOW)).toBe("hace 30min");
    expect(relativeAgo(hoursAgo(5), NOW)).toBe("hace 5h");
    expect(relativeAgo(hoursAgo(48), NOW)).toBe("hace 2d");
  });
});
