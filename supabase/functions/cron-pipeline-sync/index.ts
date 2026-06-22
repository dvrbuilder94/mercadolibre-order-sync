import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Runs the Pipeline's 5 steps (Sync MeLi → Sync pagos → Sync Bsale → RUTs →
// Conciliar) for every connected account, on a pg_cron schedule (no JWT,
// service role — same pattern as cron-refresh-meli-tokens). Scoped to the
// current + previous month, since that's what actually needs to stay fresh.
//
// Each step is just the existing user-facing edge function, called with the
// service-role key + an explicit user_id (see _shared/auth.ts) instead of a
// user session — the business logic isn't duplicated here.

// --- Chile wall-clock helpers (mirrors src/lib/chileDate.ts; duplicated
// because edge functions can't import from src/) ---
function chileWallToUnix(year: number, month: number, day: number, hour: number, min: number, sec: number): number {
  let ts = Date.UTC(year, month - 1, day, hour, min, sec);
  const target = ts;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    const curr = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const diff = target - curr;
    if (diff === 0) break;
    ts += diff;
  }
  return Math.floor(ts / 1000);
}

function chileMonthUnixRange(period: string): { from: number; to: number } {
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: chileWallToUnix(y, m, 1, 0, 0, 0),
    to: chileWallToUnix(y, m, lastDay, 23, 59, 59),
  };
}

function chilePeriodNow(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  return `${y}-${m}`;
}

function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
}

// --- Step invocation ---
async function callStep(admin: SupabaseClient, name: string, body: Record<string, unknown>) {
  const { data, error } = await admin.functions.invoke(name, { body });
  if (error) {
    let detail: any = null;
    try { detail = await (error as any)?.context?.json?.(); } catch { /* ignore */ }
    throw new Error(detail?.error || detail?.message || error.message || `${name} failed`);
  }
  return data;
}

async function runStep(
  admin: SupabaseClient,
  step: string,
  userId: string | null,
  meliAccountId: string | null,
  period: string | null,
  fn: () => Promise<any>,
): Promise<{ step: string; user_id: string | null; period: string | null; ok: boolean; detail?: any }> {
  const { data: row } = await admin
    .from('pipeline_sync_runs')
    .insert({ step, user_id: userId, meli_account_id: meliAccountId, period, status: 'running' })
    .select('id')
    .single();

  try {
    const detail = await fn();
    if (row) {
      await admin.from('pipeline_sync_runs')
        .update({ status: 'ok', finished_at: new Date().toISOString(), detail })
        .eq('id', row.id);
    }
    return { step, user_id: userId, period, ok: true, detail };
  } catch (e: any) {
    const detail = { error: e?.message ?? String(e) };
    console.error(`[cron-pipeline-sync] ${step} failed (user=${userId}, period=${period}):`, detail.error);
    if (row) {
      await admin.from('pipeline_sync_runs')
        .update({ status: 'error', finished_at: new Date().toISOString(), detail })
        .eq('id', row.id);
    }
    return { step, user_id: userId, period, ok: false, detail };
  }
}

// --- Per-step round loops (mirror the rounds Pipeline.tsx does from the browser) ---
async function syncOrdersLoop(admin: SupabaseClient, acc: { id: string; user_id: string }, dateFrom: string, dateTo: string, timeLeft: () => boolean) {
  let totalSynced = 0, round = 0, partial = true;
  while (partial && round < 5 && timeLeft()) {
    round++;
    const data = await callStep(admin, 'sync-meli-orders', {
      date_from: dateFrom, date_to: dateTo, max_pages: 50, account_id: acc.id, user_id: acc.user_id,
    });
    totalSynced += data?.synced ?? 0;
    partial = !!data?.partial;
  }
  return { rounds: round, totalSynced, partial };
}

async function syncPaymentsLoop(admin: SupabaseClient, acc: { id: string; user_id: string }, dateFrom: string, dateTo: string, timeLeft: () => boolean) {
  let totalLinked = 0, round = 0, remaining = 0;
  while (round < 10 && timeLeft()) {
    round++;
    const data = await callStep(admin, 'sync-meli-payment-details', {
      date_from: dateFrom, date_to: dateTo, limit: 50, account_id: acc.id, user_id: acc.user_id,
    });
    totalLinked += data?.paymentsLinked ?? 0;
    remaining = data?.remaining ?? 0;
    if (remaining === 0 || (data?.updated ?? 0) === 0) break;
  }
  return { rounds: round, totalLinked, remaining };
}

async function enrichRutsLoop(admin: SupabaseClient, acc: { id: string; user_id: string }, dateFrom: string, dateTo: string, timeLeft: () => boolean) {
  let totalEnriched = 0, round = 0, remaining = 0;
  while (round < 20 && timeLeft()) {
    round++;
    const data = await callStep(admin, 'enrich-meli-billing', {
      date_from: dateFrom, date_to: dateTo, account_id: acc.id, user_id: acc.user_id,
    });
    totalEnriched += data?.enriched ?? 0;
    remaining = data?.remaining ?? 0;
    if (remaining === 0 || (data?.enriched ?? 0) === 0) break;
  }
  return { rounds: round, totalEnriched, remaining };
}

// Bsale's pagination cursor lives in the browser's localStorage when driven
// from Pipeline.tsx — there's no browser here, so it's persisted in
// bsale_sync_checkpoints instead, scoped per (user_id, period).
async function syncBsaleLoop(admin: SupabaseClient, userId: string, period: string, timeLeft: () => boolean) {
  const { from: dateFrom, to: dateTo } = chileMonthUnixRange(period);
  const { data: ckptRow } = await admin
    .from('bsale_sync_checkpoints')
    .select('*')
    .eq('user_id', userId)
    .eq('period', period)
    .maybeSingle();

  let cursor: { code_sii: number; offset: number } | null = ckptRow?.cursor ?? null;
  let batchId: string | null = ckptRow?.batch_id ?? null;
  let totalAvailable: number | null = ckptRow?.total_available ?? null;
  let totalUpserted = 0, rounds = 0;

  while (rounds < 8 && timeLeft()) {
    rounds++;
    const data = await callStep(admin, 'sync-bsale-docs', {
      date_from: dateFrom, date_to: dateTo, max_pages: 20,
      ...(batchId ? { resync_batch: batchId } : {}),
      ...(cursor ? { start_code_sii: cursor.code_sii, start_offset: cursor.offset } : {}),
      user_id: userId,
    });

    totalUpserted += data?.summary?.total_upserted ?? 0;
    batchId = data?.resync_batch ?? batchId;
    if (data?.summary?.total_available != null) totalAvailable = data.summary.total_available;
    cursor = data?.next_cursor ?? null;

    if (cursor) {
      await admin.from('bsale_sync_checkpoints').upsert({
        user_id: userId, period, cursor, batch_id: batchId, total_available: totalAvailable,
        updated_at: new Date().toISOString(),
      });
    }
    if (!data?.partial) break;
  }

  if (!cursor) {
    await admin.from('bsale_sync_checkpoints').delete().eq('user_id', userId).eq('period', period);
  }
  return { rounds, totalUpserted, resumePending: !!cursor };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const startedAt = Date.now();
  const BUDGET_MS = 100_000; // margen bajo el límite (~150s) de Edge Functions
  const timeLeft = () => Date.now() - startedAt < BUDGET_MS;

  const currentPeriod = chilePeriodNow();
  const periods = [currentPeriod, shiftPeriod(currentPeriod, -1)];

  const { data: meliAccountsRaw, error: meliErr } = await admin
    .from('meli_accounts')
    .select('id, user_id')
    .not('access_token', 'is', null);
  if (meliErr) console.error('[cron-pipeline-sync] Error listing meli_accounts:', meliErr);
  const accounts = meliAccountsRaw ?? [];

  const { data: bsaleAccountsRaw, error: bsaleErr } = await admin
    .from('bsale_accounts')
    .select('user_id')
    .eq('status', 'connected');
  if (bsaleErr) console.error('[cron-pipeline-sync] Error listing bsale_accounts:', bsaleErr);

  const userIds = Array.from(new Set([
    ...accounts.map((a: any) => a.user_id as string),
    ...((bsaleAccountsRaw ?? []).map((a: any) => a.user_id as string)),
  ]));

  console.log(`[cron-pipeline-sync] ${accounts.length} meli accounts, ${userIds.length} distinct users, periods: ${periods.join(', ')}`);

  const results: any[] = [];

  outer: for (const period of periods) {
    if (!timeLeft()) { console.log('[cron-pipeline-sync] time budget exceeded, stopping'); break outer; }
    const { from, to } = periodRange(period);
    const dateFrom = `${from}T00:00:00`;
    const dateTo = `${to}T23:59:59`;

    // 1 & 2: per MELI account — Sync MeLi, Sync pagos
    for (const acc of accounts) {
      if (!timeLeft()) break outer;
      results.push(await runStep(admin, 'sync_meli_orders', acc.user_id, acc.id, period,
        () => syncOrdersLoop(admin, acc, dateFrom, dateTo, timeLeft)));
      if (!timeLeft()) break outer;
      results.push(await runStep(admin, 'sync_payments', acc.user_id, acc.id, period,
        () => syncPaymentsLoop(admin, acc, dateFrom, dateTo, timeLeft)));
    }

    // 3: per user — Sync Bsale (needs to land before RUTs/Conciliar, same order as Pipeline.tsx)
    for (const userId of userIds) {
      if (!timeLeft()) break outer;
      results.push(await runStep(admin, 'sync_bsale', userId, null, period,
        () => syncBsaleLoop(admin, userId, period, timeLeft)));
    }

    // 4: per MELI account — RUTs
    for (const acc of accounts) {
      if (!timeLeft()) break outer;
      results.push(await runStep(admin, 'enrich_ruts', acc.user_id, acc.id, period,
        () => enrichRutsLoop(admin, acc, dateFrom, dateTo, timeLeft)));
    }

    // 5: per user — Conciliar
    for (const userId of userIds) {
      if (!timeLeft()) break outer;
      results.push(await runStep(admin, 'reconcile', userId, null, period,
        () => callStep(admin, 'auto-reconcile', { date_from: dateFrom, date_to: dateTo, user_id: userId })));
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`[cron-pipeline-sync] Done: ${results.length} steps run, ${failed.length} failed`);

  return new Response(
    JSON.stringify({
      success: failed.length === 0,
      periods,
      steps_run: results.length,
      steps_failed: failed.length,
      results,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
