import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chileMonthIsoRange } from '../_shared/chile-date.ts';
import { isInternalRequest, unauthorizedJson } from '../_shared/internal-request.ts';
import {
  enrichRutsLoop,
  recordPipelineStep,
  reconcilePeriod,
  syncBsaleLoop,
  syncMercadoPagoCash,
  syncOrdersLoop,
  syncPaymentsLoop,
  type MeliSyncAccount,
} from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cron-secret, x-client-info, apikey, content-type',
};

// Scheduler automático de Sync.
//
// IMPORTANTE: la lógica de ejecución de cada paso/loop vive en
// `_shared/sync-pipeline.ts`. Este archivo sólo decide qué tenants y períodos
// necesitan correr. El futuro runner manual debe reutilizar el mismo motor.

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: corsHeaders });
  }
  if (!await isInternalRequest(req)) return unauthorizedJson(corsHeaders);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const startedAt = Date.now();
  const BUDGET_MS = 100_000;
  const timeLeft = () => Date.now() - startedAt < BUDGET_MS;

  const currentPeriod = chilePeriodNow();
  const periods = [currentPeriod, shiftPeriod(currentPeriod, -1)];

  const { data: meliAccountsRaw, error: meliErr } = await admin
    .from('meli_accounts')
    .select('id, user_id')
    .not('access_token', 'is', null);
  if (meliErr) console.error('[cron-pipeline-sync] Error listing meli_accounts:', meliErr);
  const accounts = (meliAccountsRaw ?? []) as MeliSyncAccount[];

  const { data: bsaleAccountsRaw, error: bsaleErr } = await admin
    .from('bsale_accounts')
    .select('user_id')
    .eq('status', 'connected');
  if (bsaleErr) console.error('[cron-pipeline-sync] Error listing bsale_accounts:', bsaleErr);

  const userIds = Array.from(new Set([
    ...accounts.map(a => a.user_id),
    ...((bsaleAccountsRaw ?? []).map((a: any) => a.user_id as string)),
  ]));

  console.log(`[cron-pipeline-sync] ${accounts.length} meli accounts, ${userIds.length} distinct users, periods: ${periods.join(', ')}`);

  const results: any[] = [];

  outer: for (const period of periods) {
    if (!timeLeft()) {
      console.log('[cron-pipeline-sync] time budget exceeded, stopping');
      break outer;
    }

    const { from: dateFrom, to: dateTo } = chileMonthIsoRange(period);

    // 1–3: por cuenta MELI.
    for (const acc of accounts) {
      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'sync_meli_orders',
        acc.user_id,
        acc.id,
        period,
        () => syncOrdersLoop(admin, acc, dateFrom, dateTo, timeLeft),
      ));

      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'sync_payments',
        acc.user_id,
        acc.id,
        period,
        () => syncPaymentsLoop(admin, acc, dateFrom, dateTo, timeLeft),
      ));

      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'sync_mp_cash',
        acc.user_id,
        acc.id,
        period,
        () => syncMercadoPagoCash(admin, acc, dateFrom, dateTo),
      ));
    }

    // 4: por tenant/owner — Bsale.
    for (const userId of userIds) {
      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'sync_bsale',
        userId,
        null,
        period,
        () => syncBsaleLoop(admin, userId, period, timeLeft),
      ));
    }

    // 5: por cuenta MELI — RUTs.
    for (const acc of accounts) {
      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'enrich_ruts',
        acc.user_id,
        acc.id,
        period,
        () => enrichRutsLoop(admin, acc, dateFrom, dateTo, timeLeft),
      ));
    }

    // 6: por tenant/owner — conciliación.
    for (const userId of userIds) {
      if (!timeLeft()) break outer;
      results.push(await recordPipelineStep(
        admin,
        'reconcile',
        userId,
        null,
        period,
        () => reconcilePeriod(admin, userId, period),
      ));
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
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
