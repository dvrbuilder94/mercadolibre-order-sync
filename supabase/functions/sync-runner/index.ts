import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chileMonthIsoRange, chileMonthUnixRange } from '../_shared/chile-date.ts';
import { isInternalRequest, unauthorizedJson } from '../_shared/internal-request.ts';
import {
  CANONICAL_SYNC_STEPS,
  callSyncWorker,
  type CanonicalSyncStep,
} from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cron-secret, x-client-info, apikey, content-type',
};

const MAX_RETRIES_PER_CHUNK = 3;
const MAX_PAYMENT_ROUNDS_PER_ACCOUNT = 20;
const MAX_RUT_ROUNDS_PER_ACCOUNT = 20;

interface SyncRunRow {
  id: string;
  organization_id: string;
  owner_user_id: string;
  period: string;
  mode: string;
  status: string;
  current_step: CanonicalSyncStep | null;
  summary: any;
}

interface RunnerState {
  meli_account_ids?: string[];
  has_bsale?: boolean;
  account_index?: number;
  meli_offsets?: Record<string, number>;
  payment_rounds?: Record<string, number>;
  rut_rounds?: Record<string, number>;
  failures?: Record<string, number>;
  bsale?: {
    cursor?: { code_sii: number; offset: number } | null;
    batch_id?: string | null;
    total_available?: number | null;
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function nextStep(step: CanonicalSyncStep): CanonicalSyncStep | null {
  const index = CANONICAL_SYNC_STEPS.indexOf(step);
  return index >= 0 && index + 1 < CANONICAL_SYNC_STEPS.length
    ? CANONICAL_SYNC_STEPS[index + 1]
    : null;
}

function ensureSummary(raw: any) {
  const summary = raw && typeof raw === 'object' ? { ...raw } : {};
  summary.state = summary.state && typeof summary.state === 'object' ? { ...summary.state } : {};
  summary.metrics = summary.metrics && typeof summary.metrics === 'object' ? { ...summary.metrics } : {};
  return summary;
}

function touchMetric(summary: any, step: CanonicalSyncStep, patch: Record<string, unknown> = {}) {
  const previous = summary.metrics?.[step] ?? {};
  summary.metrics[step] = {
    ...previous,
    chunks: Number(previous.chunks ?? 0) + 1,
    ...patch,
    updated_at: new Date().toISOString(),
  };
}

function advance(summary: any, currentStep: CanonicalSyncStep): CanonicalSyncStep | null {
  const next = nextStep(currentStep);
  const state = summary.state as RunnerState;
  state.account_index = 0;
  delete state.failures;
  return next;
}

async function nextAttempt(admin: any, runId: string, step: CanonicalSyncStep, accountId: string | null) {
  let query = admin
    .from('pipeline_sync_runs')
    .select('attempt')
    .eq('sync_run_id', runId)
    .eq('step', step)
    .order('attempt', { ascending: false })
    .limit(1);
  query = accountId ? query.eq('meli_account_id', accountId) : query.is('meli_account_id', null);
  const { data } = await query.maybeSingle();
  return Number((data as any)?.attempt ?? 0) + 1;
}

async function runChunkAttempt(
  admin: any,
  run: SyncRunRow,
  step: CanonicalSyncStep,
  accountId: string | null,
  fn: () => Promise<any>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const attempt = await nextAttempt(admin, run.id, step, accountId);
  const { data: rowRaw, error: insertError } = await admin
    .from('pipeline_sync_runs')
    .insert({
      sync_run_id: run.id,
      attempt,
      step,
      user_id: run.owner_user_id,
      meli_account_id: accountId,
      period: run.period,
      status: 'running',
    })
    .select('id')
    .single();
  const row = rowRaw as any;

  if (insertError || !row) {
    return { ok: false, error: insertError?.message || 'Failed to create step attempt' };
  }

  try {
    const data = await fn();
    const businessOk = data?.success !== false;
    await admin.from('pipeline_sync_runs').update({
      status: businessOk ? 'ok' : 'error',
      finished_at: new Date().toISOString(),
      detail: data ?? {},
    }).eq('id', row.id);

    return businessOk
      ? { ok: true, data }
      : { ok: false, data, error: data?.error || data?.message || 'Worker reported failure' };
  } catch (error: any) {
    const message = error?.message || String(error);
    await admin.from('pipeline_sync_runs').update({
      status: 'error',
      finished_at: new Date().toISOString(),
      detail: { error: message },
    }).eq('id', row.id);
    return { ok: false, error: message };
  }
}

async function failOrRetry(
  admin: any,
  run: SyncRunRow,
  summary: any,
  step: CanonicalSyncStep,
  key: string,
  error: string,
) {
  const state = summary.state as RunnerState;
  state.failures = state.failures ?? {};
  const failures = Number(state.failures[key] ?? 0) + 1;
  state.failures[key] = failures;

  touchMetric(summary, step, { last_error: error, retry_count: failures });

  if (failures < MAX_RETRIES_PER_CHUNK) {
    await saveAndRequeue(admin, run.id, step, summary);
    return { retried: true, failures };
  }

  await admin.from('sync_runs').update({
    status: 'error',
    current_step: step,
    summary,
    error: { step, message: error, attempts: failures },
    finished_at: new Date().toISOString(),
    runner_lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq('id', run.id);
  return { retried: false, failures };
}

async function saveAndRequeue(
  admin: any,
  runId: string,
  currentStep: CanonicalSyncStep,
  summary: any,
) {
  const { error: saveError } = await admin.from('sync_runs').update({
    status: 'running',
    current_step: currentStep,
    summary,
    updated_at: new Date().toISOString(),
  }).eq('id', runId).eq('status', 'running');
  if (saveError) throw new Error(`Failed to persist Sync state: ${saveError.message}`);

  const { error: queueError } = await admin.rpc('requeue_sync_runner', { p_run_id: runId });
  if (queueError) throw new Error(`Failed to requeue Sync runner: ${queueError.message}`);
}

async function finishRun(admin: any, runId: string, summary: any) {
  const { error } = await admin.from('sync_runs').update({
    status: 'ok',
    current_step: null,
    summary,
    finished_at: new Date().toISOString(),
    runner_lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq('id', runId).eq('status', 'running');
  if (error) throw new Error(`Failed to finish Sync run: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: corsHeaders });
  if (!await isInternalRequest(req)) return unauthorizedJson(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceKey);

  let runId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    runId = body?.run_id ?? null;
    if (!isUuid(runId)) {
      return new Response(JSON.stringify({ error: 'Invalid run_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: claimedRaw, error: claimError } = await admin.rpc('claim_sync_run', { p_run_id: runId });
    if (claimError) throw new Error(`Failed to claim Sync run: ${claimError.message}`);
    if (claimedRaw !== true) {
      return new Response(JSON.stringify({ success: true, skipped: 'leased_or_inactive', run_id: runId }), {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: runRaw, error: runError } = await admin
      .from('sync_runs')
      .select('id, organization_id, owner_user_id, period, mode, status, current_step, summary')
      .eq('id', runId)
      .single();
    const run = runRaw as unknown as SyncRunRow | null;
    if (runError || !run) throw new Error(runError?.message || 'Sync run not found');
    if (run.mode !== 'full') throw new Error(`Unsupported Sync mode: ${run.mode}`);

    const summary = ensureSummary(run.summary);
    const state = summary.state as RunnerState;

    // Snapshot source accounts once so the run is deterministic even if a new
    // connection is added halfway through the month sync.
    if (!Array.isArray(state.meli_account_ids)) {
      const { data: accountRows, error: accountError } = await admin
        .from('meli_accounts')
        .select('id')
        .eq('user_id', run.owner_user_id)
        .not('access_token', 'is', null)
        .order('id', { ascending: true });
      if (accountError) throw new Error(`Failed to list MELI accounts: ${accountError.message}`);
      state.meli_account_ids = (accountRows ?? []).map((row: any) => String(row.id));
    }
    if (typeof state.has_bsale !== 'boolean') {
      const { data: bsaleRow, error: bsaleError } = await admin
        .from('bsale_accounts')
        .select('id')
        .eq('user_id', run.owner_user_id)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();
      if (bsaleError) throw new Error(`Failed to inspect Bsale connection: ${bsaleError.message}`);
      state.has_bsale = !!bsaleRow;
    }

    const accounts = state.meli_account_ids ?? [];
    const step = (run.current_step || CANONICAL_SYNC_STEPS[0]) as CanonicalSyncStep;
    if (!CANONICAL_SYNC_STEPS.includes(step)) throw new Error(`Unknown Sync step: ${step}`);

    const { from: dateFrom, to: dateTo } = chileMonthIsoRange(run.period);
    const index = Number(state.account_index ?? 0);

    if (step === 'sync_meli_orders') {
      if (index >= accounts.length) {
        const next = advance(summary, step)!;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        const accountId = accounts[index];
        state.meli_offsets = state.meli_offsets ?? {};
        const offset = Number(state.meli_offsets[accountId] ?? 0);
        const attempt = await runChunkAttempt(admin, run, step, accountId, () => callSyncWorker(admin, 'sync-meli-orders', {
          date_from: dateFrom,
          date_to: dateTo,
          max_pages: 10,
          start_offset: offset,
          account_id: accountId,
          user_id: run.owner_user_id,
        }));

        if (!attempt.ok) {
          await failOrRetry(admin, run, summary, step, `${step}:${accountId}:${offset}`, attempt.error || 'MELI order chunk failed');
        } else {
          const data = attempt.data ?? {};
          delete state.failures?.[`${step}:${accountId}:${offset}`];
          touchMetric(summary, step, {
            synced: Number(summary.metrics?.[step]?.synced ?? 0) + Number(data?.synced ?? 0),
            available: data?.available ?? summary.metrics?.[step]?.available ?? null,
          });
          if (data?.partial) {
            const nextOffset = Number(data?.next_cursor?.offset);
            if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset === offset) {
              await failOrRetry(admin, run, summary, step, `${step}:${accountId}:${offset}`, 'MELI returned a stalled/invalid cursor');
            } else {
              state.meli_offsets[accountId] = nextOffset;
              await saveAndRequeue(admin, run.id, step, summary);
            }
          } else {
            delete state.meli_offsets[accountId];
            state.account_index = index + 1;
            const next = state.account_index >= accounts.length ? advance(summary, step)! : step;
            await saveAndRequeue(admin, run.id, next, summary);
          }
        }
      }
    } else if (step === 'sync_payments') {
      if (index >= accounts.length) {
        const next = advance(summary, step)!;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        const accountId = accounts[index];
        state.payment_rounds = state.payment_rounds ?? {};
        const rounds = Number(state.payment_rounds[accountId] ?? 0);
        const attempt = await runChunkAttempt(admin, run, step, accountId, () => callSyncWorker(admin, 'sync-meli-payment-details', {
          date_from: dateFrom,
          date_to: dateTo,
          limit: 50,
          account_id: accountId,
          user_id: run.owner_user_id,
        }));

        if (!attempt.ok) {
          await failOrRetry(admin, run, summary, step, `${step}:${accountId}:${rounds}`, attempt.error || 'MELI payment chunk failed');
        } else {
          const data = attempt.data ?? {};
          const nextRounds = rounds + 1;
          state.payment_rounds[accountId] = nextRounds;
          touchMetric(summary, step, {
            linked: Number(summary.metrics?.[step]?.linked ?? 0) + Number(data?.paymentsLinked ?? 0),
            remaining: Number(data?.remaining ?? 0),
          });
          const keepGoing = Number(data?.remaining ?? 0) > 0
            && Number(data?.updated ?? 0) > 0
            && nextRounds < MAX_PAYMENT_ROUNDS_PER_ACCOUNT;
          if (keepGoing) {
            await saveAndRequeue(admin, run.id, step, summary);
          } else {
            state.account_index = index + 1;
            const next = state.account_index >= accounts.length ? advance(summary, step)! : step;
            await saveAndRequeue(admin, run.id, next, summary);
          }
        }
      }
    } else if (step === 'sync_mp_cash') {
      if (index >= accounts.length) {
        const next = advance(summary, step)!;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        const accountId = accounts[index];
        const attempt = await runChunkAttempt(admin, run, step, accountId, () => callSyncWorker(admin, 'check-orphan-payments', {
          date_from: dateFrom,
          date_to: dateTo,
          account_id: accountId,
          user_id: run.owner_user_id,
        }));
        if (!attempt.ok) {
          await failOrRetry(admin, run, summary, step, `${step}:${accountId}`, attempt.error || 'Mercado Pago cash sync failed');
        } else {
          touchMetric(summary, step);
          state.account_index = index + 1;
          const next = state.account_index >= accounts.length ? advance(summary, step)! : step;
          await saveAndRequeue(admin, run.id, next, summary);
        }
      }
    } else if (step === 'sync_bsale') {
      if (!state.has_bsale) {
        touchMetric(summary, step, { skipped: true, reason: 'not_connected' });
        const next = advance(summary, step)!;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        const { from: bsaleFrom, to: bsaleTo } = chileMonthUnixRange(run.period);
        state.bsale = state.bsale ?? {};
        const attempt = await runChunkAttempt(admin, run, step, null, () => callSyncWorker(admin, 'sync-bsale-docs', {
          date_from: bsaleFrom,
          date_to: bsaleTo,
          max_pages: 10,
          ...(state.bsale?.batch_id ? { resync_batch: state.bsale.batch_id } : {}),
          ...(state.bsale?.cursor ? {
            start_code_sii: state.bsale.cursor.code_sii,
            start_offset: state.bsale.cursor.offset,
          } : {}),
          user_id: run.owner_user_id,
        }));

        if (!attempt.ok) {
          await failOrRetry(admin, run, summary, step, `${step}:${state.bsale?.cursor?.code_sii ?? 0}:${state.bsale?.cursor?.offset ?? 0}`, attempt.error || 'Bsale chunk failed');
        } else {
          const data = attempt.data ?? {};
          state.bsale.batch_id = data?.resync_batch ?? state.bsale.batch_id ?? null;
          state.bsale.total_available = data?.summary?.total_available ?? state.bsale.total_available ?? null;
          state.bsale.cursor = data?.next_cursor ?? null;
          touchMetric(summary, step, {
            upserted: Number(summary.metrics?.[step]?.upserted ?? 0) + Number(data?.summary?.total_upserted ?? 0),
            available: state.bsale.total_available,
          });

          if (state.bsale.cursor) {
            await admin.from('bsale_sync_checkpoints').upsert({
              user_id: run.owner_user_id,
              period: run.period,
              cursor: state.bsale.cursor,
              batch_id: state.bsale.batch_id,
              total_available: state.bsale.total_available,
              updated_at: new Date().toISOString(),
            });
          } else {
            await admin.from('bsale_sync_checkpoints').delete()
              .eq('user_id', run.owner_user_id)
              .eq('period', run.period);
          }

          if (data?.partial) {
            if (!state.bsale.cursor) {
              await failOrRetry(admin, run, summary, step, `${step}:missing_cursor`, 'Bsale returned partial without next_cursor');
            } else {
              await saveAndRequeue(admin, run.id, step, summary);
            }
          } else {
            const next = advance(summary, step)!;
            await saveAndRequeue(admin, run.id, next, summary);
          }
        }
      }
    } else if (step === 'enrich_ruts') {
      if (index >= accounts.length) {
        const next = advance(summary, step)!;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        const accountId = accounts[index];
        state.rut_rounds = state.rut_rounds ?? {};
        const rounds = Number(state.rut_rounds[accountId] ?? 0);
        const attempt = await runChunkAttempt(admin, run, step, accountId, () => callSyncWorker(admin, 'enrich-meli-billing', {
          date_from: dateFrom,
          date_to: dateTo,
          account_id: accountId,
          user_id: run.owner_user_id,
        }));

        if (!attempt.ok) {
          await failOrRetry(admin, run, summary, step, `${step}:${accountId}:${rounds}`, attempt.error || 'RUT enrichment chunk failed');
        } else {
          const data = attempt.data ?? {};
          const nextRounds = rounds + 1;
          state.rut_rounds[accountId] = nextRounds;
          touchMetric(summary, step, {
            enriched: Number(summary.metrics?.[step]?.enriched ?? 0) + Number(data?.enriched ?? 0),
            remaining: Number(data?.remaining ?? 0),
          });
          const keepGoing = Number(data?.remaining ?? 0) > 0
            && Number(data?.enriched ?? 0) > 0
            && nextRounds < MAX_RUT_ROUNDS_PER_ACCOUNT;
          if (keepGoing) {
            await saveAndRequeue(admin, run.id, step, summary);
          } else {
            state.account_index = index + 1;
            const next = state.account_index >= accounts.length ? advance(summary, step)! : step;
            await saveAndRequeue(admin, run.id, next, summary);
          }
        }
      }
    } else if (step === 'reconcile') {
      const attempt = await runChunkAttempt(admin, run, step, null, () => callSyncWorker(admin, 'auto-reconcile', {
        date_from: dateFrom,
        date_to: dateTo,
        user_id: run.owner_user_id,
      }));
      if (!attempt.ok) {
        await failOrRetry(admin, run, summary, step, step, attempt.error || 'Auto-reconcile failed');
      } else {
        touchMetric(summary, step, { completed: true });
        await finishRun(admin, run.id, summary);
      }
    }

    return new Response(JSON.stringify({ success: true, run_id: run.id, step }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error('[sync-runner]', runId, message);
    if (runId && isUuid(runId)) {
      await admin.from('sync_runs').update({
        status: 'error',
        error: { stage: 'runner', message },
        finished_at: new Date().toISOString(),
        runner_lease_until: null,
        updated_at: new Date().toISOString(),
      }).eq('id', runId).in('status', ['queued', 'running']);
    }
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
