// Converts a Chile wall-clock date/time (America/Santiago, handles CLT/CLST
// automatically) to a Unix timestamp in seconds. Iterates because the UTC
// offset itself depends on the date being converted (DST).
export const chileWallToUnix = (
  year: number, month: number, day: number,
  hour: number, min: number, sec: number
): number => {
  let ts = Date.UTC(year, month - 1, day, hour, min, sec);
  const target = ts;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    const curr = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    const diff = target - curr;
    if (diff === 0) break;
    ts += diff;
  }
  return Math.floor(ts / 1000);
};

// "yyyy-MM" period -> Unix second range covering the whole month in Chile
// wall-clock time. Used for edge functions whose date filters are unix
// seconds (e.g. sync-bsale-docs's emission date range).
export const chileMonthUnixRange = (p: string) => {
  const { year: y, month: m } = parsePeriod(p);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: chileWallToUnix(y, m, 1, 0, 0, 0),
    to:   chileWallToUnix(y, m, lastDay, 23, 59, 59),
  };
};

const parsePeriod = (period: string) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error(`Período inválido: ${period}`);
  return { year: Number(match[1]), month: Number(match[2]) };
};

/** Date-only limits for DATE columns such as tax_documents.document_date. */
export const chileMonthDateRange = (period: string) => {
  const { year, month } = parsePeriod(period);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
};

/**
 * UTC instants that cover exactly one Chile calendar month. Database queries
 * should use gte(from) + lt(toExclusive) to avoid DST and millisecond gaps.
 */
export const chileMonthIsoRange = (period: string) => {
  const { year, month } = parsePeriod(period);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fromMs = chileWallToUnix(year, month, 1, 0, 0, 0) * 1000;
  const nextMs = chileWallToUnix(nextYear, nextMonth, 1, 0, 0, 0) * 1000;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(nextMs - 1).toISOString(),
    toExclusive: new Date(nextMs).toISOString(),
  };
};

export const chilePeriodNow = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}`;
};
