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
  const [y, m] = p.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: chileWallToUnix(y, m, 1, 0, 0, 0),
    to:   chileWallToUnix(y, m, lastDay, 23, 59, 59),
  };
};
