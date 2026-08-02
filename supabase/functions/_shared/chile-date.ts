export function chileWallToUnix(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
): number {
  let timestamp = Date.UTC(year, month - 1, day, hour, min, sec);
  const target = timestamp;
  for (let index = 0; index < 3; index++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    const current = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'),
    );
    const difference = target - current;
    if (difference === 0) break;
    timestamp += difference;
  }
  return Math.floor(timestamp / 1000);
}

export function chileMonthUnixRange(period: string): { from: number; to: number } {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: chileWallToUnix(year, month, 1, 0, 0, 0),
    to: chileWallToUnix(year, month, lastDay, 23, 59, 59),
  };
}

export function chileMonthIsoRange(period: string): { from: string; to: string } {
  const [year, month] = period.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fromMs = chileWallToUnix(year, month, 1, 0, 0, 0) * 1000;
  const nextMs = chileWallToUnix(nextYear, nextMonth, 1, 0, 0, 0) * 1000;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(nextMs - 1).toISOString(),
  };
}
