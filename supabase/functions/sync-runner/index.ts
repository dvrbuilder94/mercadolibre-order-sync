import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chileMonthIsoRange, chileMonthUnixRange } from '../_shared/chile-date.ts';
import { isInternalRequest, unauthorizedJson } from '../_shared/internal-request.ts';
import { callSyncWorker } from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cron-secret, x-client-info, apikey, content-type',
};

const MAX_RETRIES_PER_CHUNK = 3;
const MAX_PAYMENT_ROUNDS_PER_ACCOUNT = 20;
const MAX_RUT_ROUNDS_PER_ACCOUNT = 20;

type SourceType = 'meli' | 'shopify' | 'mercadopago' | 'bsale';
type RunnerStep =
  | 'sync_meli_orders'
  | 'sync_payments'
  | 'enrich_ruts'
  | 'sync_shopify_orders'
  | 'sync_mercadopago_payments'
  | 'sync_bsale'
  | 'reconcile';

type SyncTarget = { source_type: SourceType; connection_id: string };

interface SyncRunRow {
  id: string;
  organization_id: string;
  owner_user_id: string;
  period: string;
  mode: 'full' | 'source' | 'reconcile_only';
  source_type: SourceType | null;
  source_connection_id: string | null;
  status: string;
  current_step: RunnerStep | null;
  summary: any;
}

interface RunnerState {
  failures?: Record<string, number>;
  meli_offsets?: Record<string, number>;
  payment_rounds?: Record<string, number>;
  rut_rounds?: Record<string, number>;
  shopify_cursor?: string | null;
  bsale?: {
    cursor?: { code_sii: number; offset: number } | null;
    batch_id?: string | null;
    total_available?: number | null;
  };
  full_connections?: SyncTarget[];
  full_connection_index?: number;
  full_connection_step?: RunnerStep | null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function ensureSummary(raw: any) {
  const summary = raw && typeof raw === 'object' ? { ...raw } : {};
  summary.state = summary.state && typeof summary.state === 'object' ? { ...summary.state } : {};
  summary.metrics = summary.metrics && typeof summary.metrics === 'object' ? { ...summary.metrics } : {};
  return summary;
}

function initialStep(sourceType: SourceType): RunnerStep {
  if (sourceType === 'meli') return 'sync_meli_orders';
  if (sourceType === 'shopify') return 'sync_shopify_orders';
  if (sourceType === 'mercadopago') return 'sync_mercadopago_payments';
  return 'sync_bsale';
}

function touchMetric(summary: any, step: RunnerStep, patch: Record<string, unknown> = {}) {
  const previous = summary.metrics?.[step] ?? {};
  summary.metrics[step] = {
    ...previous,
    chunks: Number(previous.chunks ?? 0) + 1,
    ...patch,
    updated_at: new Date().toISOString(),
  };
}

async function nextAttempt(
  admin: any,
  runId: string,
  step: RunnerStep,
  target: SyncTarget | null,
) {
  let query = admin
    .from('pipeline_sync_runs')
    .select('attempt')
    .eq('sync_run_id', runId)
    .eq('step', step)
    .order('attempt', { ascending: false })
    .limit(1);
  query = target
    ? query.eq('source_type', target.source_type).eq('source_connection_id', target.connection_id)
    : query.is('source_type', null).is('source_connection_id', null);
  const { data } = await query.maybeSingle();
  return Number((data as any)?.attempt ?? 0) + 1;
}

async function runChunkAttempt(
  admin: any,
  run: SyncRunRow,
  step: RunnerStep,
  target: SyncTarget | null,
  fn: () => Promise<any>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const attempt = await nextAttempt(admin, run.id, step, target);
  const { data: rowRaw, error: insertError } = await admin
    .from('pipeline_sync_runs')
    .insert({
      sync_run_id: run.id,
      attempt,
      step,
      user_id: run.owner_user_id,
      meli_account_id: target?.source_type === 'meli' ? target.connection_id : null,
      source_type: target?.source_type ?? null,
      source_connection_id: target?.connection_id ?? null,
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
    const businessOk = data?.success !== false && !data?.error_detail;
    await admin.from('pipeline_sync_runs').update({
      status: businessOk ? 'ok' : 'error',
      finished_at: new Date().toISOString(),
      detail: data ?? {},
    }).eq('id', row.id);

    return businessOk
      ? { ok: true, data }
      : {
          ok: false,
          data,
          error: data?.error_detail || data?.error || data?.message || 'Worker reported failure',
        };
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

async function saveAndRequeue(
  admin: any,
  runId: string,
  currentStep: RunnerStep,
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

async function failOrRetry(
  admin: any,
  run: SyncRunRow,
  summary: any,
  step: RunnerStep,
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
    return;
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
}

function clearTargetState(state: RunnerState, target: SyncTarget) {
  delete state.failures;
  if (target.source_type === 'meli') {
    if (state.meli_offsets) delete state.meli_offsets[target.connection_id];
    if (state.payment_rounds) delete state.payment_rounds[target.connection_id];
    if (state.rut_rounds) delete state.rut_rounds[target.connection_id];
  }
  if (target.source_type === 'shopify') state.shopify_cursor = null;
  if (target.source_type === 'bsale') state.bsale = {};
}

async function loadFullConnections(admin: any, run: SyncRunRow): Promise<SyncTarget[]> {
  const targets: SyncTarget[] = [];

  const { data: meliRows, error: meliError } = await admin
    .from('meli_accounts')
    .select('id')
    .eq('user_id', run.owner_user_id)
    .not('access_token', 'is', null)
    .order('id', { ascending: true });
  if (meliError) throw new Error(`Failed to list Mercado Libre connections: ${meliError.message}`);
  for (const row of meliRows ?? []) targets.push({ source_type: 'meli', connection_id: String(row.id) });

  const { data: shopRows, error: shopError } = await admin
    .from('shopify_accounts')
    .select('id, status')
    .eq('user_id', run.owner_user_id)
    .not('access_token', 'is', null)
    .order('id', { ascending: true });
  if (shopError) throw new Error(`Failed to list Shopify connections: ${shopError.message}`);
  for (const row of shopRows ?? []) {
    if (!row.status || row.status === 'connected') targets.push({ source_type: 'shopify', connection_id: String(row.id) });
  }

  const { data: mpRows, error: mpError } = await admin
    .from('mercadopago_accounts')
    .select('id')
    .eq('user_id', run.owner_user_id)
    .eq('status', 'connected')
    .order('id', { ascending: true });
  if (mpError) throw new Error(`Failed to list Mercado Pago connections: ${mpError.message}`);
  for (const row of mpRows ?? []) targets.push({ source_type: 'mercadopago', connection_id: String(row.id) });

  const { data: bsaleRows, error: bsaleError } = await admin
    .from('bsale_accounts')
    .select('id')
    .eq('user_id', run.owner_user_id)
    .eq('status', 'connected')
    .order('id', { ascending: true });
  if (bsaleError) throw new Error(`Failed to list Bsale connections: ${bsaleError.message}`);
  for (const row of bsaleRows ?? []) targets.push({ source_type: 'bsale', connection_id: String(row.id) });

  return targets;
}

async function runReconcile(admin: any, run: SyncRunRow, summary: any) {
  const { from: dateFrom, to: dateTo } = chileMonthIsoRange(run.period);
  const attempt = await runChunkAttempt(admin, run, 'reconcile', null, () => callSyncWorker(admin, 'auto-reconcile', {
    date_from: dateFrom,
    date_to: dateTo,
    user_id: run.owner_user_id,
  }));

  if (!attempt.ok) {
    await failOrRetry(admin, run, summary, 'reconcile', 'reconcile', attempt.error || 'Auto-reconcile failed');
    return;
  }

  touchMetric(summary, 'reconcile', { completed: true });
  await finishRun(admin, run.id, summary);
}

async function runConnectionChunk(
  admin: any,
  run: SyncRunRow,
  summary: any,
  target: SyncTarget,
  step: RunnerStep,
  onComplete: () => Promise<void>,
) {
  const state = summary.state as RunnerState;
  const { from: dateFrom, to: dateTo } = chileMonthIsoRange(run.period);

  if (target.source_type === 'meli') {
    if (step === 'sync_meli_orders') {
      state.meli_offsets = state.meli_offsets ?? {};
      const offset = Number(state.meli_offsets[target.connection_id] ?? 0);
      const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'sync-meli-orders', {
        date_from: dateFrom,
        date_to: dateTo,
        max_pages: 10,
        start_offset: offset,
        account_id: target.connection_id,
        user_id: run.owner_user_id,
      }));
      if (!attempt.ok) {
        await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${offset}`, attempt.error || 'Mercado Libre orders failed');
        return;
      }

      const data = attempt.data ?? {};
      delete state.failures?.[`${target.connection_id}:${step}:${offset}`];
      touchMetric(summary, step, {
        synced: Number(summary.metrics?.[step]?.synced ?? 0) + Number(data?.synced ?? 0),
        available: data?.available ?? summary.metrics?.[step]?.available ?? null,
      });

      if (data?.partial) {
        const nextOffset = Number(data?.next_cursor?.offset);
        if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset === offset) {
          await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${offset}`, 'Mercado Libre returned a stalled/invalid cursor');
        } else {
          state.meli_offsets[target.connection_id] = nextOffset;
          await saveAndRequeue(admin, run.id, step, summary);
        }
      } else {
        delete state.meli_offsets[target.connection_id];
        delete state.failures;
        if (run.mode === 'full') state.full_connection_step = 'sync_payments';
        await saveAndRequeue(admin, run.id, 'sync_payments', summary);
      }
      return;
    }

    if (step === 'sync_payments') {
      state.payment_rounds = state.payment_rounds ?? {};
      const rounds = Number(state.payment_rounds[target.connection_id] ?? 0);
      const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'sync-meli-payment-details', {
        date_from: dateFrom,
        date_to: dateTo,
        limit: 50,
        account_id: target.connection_id,
        user_id: run.owner_user_id,
      }));
      if (!attempt.ok) {
        await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${rounds}`, attempt.error || 'Mercado Libre payment detail failed');
        return;
      }

      const data = attempt.data ?? {};
      const nextRounds = rounds + 1;
      state.payment_rounds[target.connection_id] = nextRounds;
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
        delete state.failures;
        if (run.mode === 'full') state.full_connection_step = 'enrich_ruts';
        await saveAndRequeue(admin, run.id, 'enrich_ruts', summary);
      }
      return;
    }

    if (step === 'enrich_ruts') {
      state.rut_rounds = state.rut_rounds ?? {};
      const rounds = Number(state.rut_rounds[target.connection_id] ?? 0);
      const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'enrich-meli-billing', {
        date_from: dateFrom,
        date_to: dateTo,
        account_id: target.connection_id,
        user_id: run.owner_user_id,
      }));
      if (!attempt.ok) {
        await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${rounds}`, attempt.error || 'Mercado Libre billing enrichment failed');
        return;
      }

      const data = attempt.data ?? {};
      const nextRounds = rounds + 1;
      state.rut_rounds[target.connection_id] = nextRounds;
      touchMetric(summary, step, {
        enriched: Number(summary.metrics?.[step]?.enriched ?? 0) + Number(data?.enriched ?? 0),
        remaining: Number(data?.remaining ?? 0),
      });
      const keepGoing = Number(data?.remaining ?? 0) > 0
        && Number(data?.enriched ?? 0) > 0
        && nextRounds < MAX_RUT_ROUNDS_PER_ACCOUNT;
      if (keepGoing) await saveAndRequeue(admin, run.id, step, summary);
      else await onComplete();
      return;
    }

    throw new Error(`Unexpected Mercado Libre step: ${step}`);
  }

  if (target.source_type === 'shopify') {
    if (step !== 'sync_shopify_orders') throw new Error(`Unexpected Shopify step: ${step}`);
    const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'sync-shopify-orders', {
      date_from: dateFrom,
      date_to: dateTo,
      max_pages: 10,
      account_id: target.connection_id,
      ...(state.shopify_cursor ? { cursor: state.shopify_cursor } : {}),
      user_id: run.owner_user_id,
    }));
    if (!attempt.ok) {
      await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${state.shopify_cursor ?? 'start'}`, attempt.error || 'Shopify orders failed');
      return;
    }

    const data = attempt.data ?? {};
    touchMetric(summary, step, {
      synced: Number(summary.metrics?.[step]?.synced ?? 0) + Number(data?.synced ?? 0),
      fetched: Number(summary.metrics?.[step]?.fetched ?? 0) + Number(data?.total ?? 0),
    });
    if (data?.partial) {
      if (!data?.next_cursor || data.next_cursor === state.shopify_cursor) {
        await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:cursor`, 'Shopify returned partial without a usable next_cursor');
      } else {
        state.shopify_cursor = data.next_cursor;
        await saveAndRequeue(admin, run.id, step, summary);
      }
    } else {
      await onComplete();
    }
    return;
  }

  if (target.source_type === 'mercadopago') {
    if (step !== 'sync_mercadopago_payments') throw new Error(`Unexpected Mercado Pago step: ${step}`);
    const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'sync-mercadopago-payments', {
      date_from: dateFrom,
      date_to: dateTo,
      account_id: target.connection_id,
      user_id: run.owner_user_id,
    }));
    if (!attempt.ok) {
      await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}`, attempt.error || 'Mercado Pago sync failed');
      return;
    }

    const data = attempt.data ?? {};
    touchMetric(summary, step, {
      fetched: Number(summary.metrics?.[step]?.fetched ?? 0) + Number(data?.totalFetched ?? 0),
      approved: Number(summary.metrics?.[step]?.approved ?? 0) + Number(data?.approvedCount ?? 0),
      ingested: Number(summary.metrics?.[step]?.ingested ?? 0) + Number(data?.ingestedCount ?? 0),
      reversals: Number(summary.metrics?.[step]?.reversals ?? 0) + Number(data?.reversalCount ?? 0),
    });
    await onComplete();
    return;
  }

  if (target.source_type === 'bsale') {
    if (step !== 'sync_bsale') throw new Error(`Unexpected Bsale step: ${step}`);
    const { from: bsaleFrom, to: bsaleTo } = chileMonthUnixRange(run.period);
    state.bsale = state.bsale ?? {};
    const attempt = await runChunkAttempt(admin, run, step, target, () => callSyncWorker(admin, 'sync-bsale-docs', {
      date_from: bsaleFrom,
      date_to: bsaleTo,
      max_pages: 10,
      account_id: target.connection_id,
      ...(state.bsale?.batch_id ? { resync_batch: state.bsale.batch_id } : {}),
      ...(state.bsale?.cursor ? {
        start_code_sii: state.bsale.cursor.code_sii,
        start_offset: state.bsale.cursor.offset,
      } : {}),
      user_id: run.owner_user_id,
    }));
    if (!attempt.ok) {
      await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:${state.bsale?.cursor?.code_sii ?? 0}:${state.bsale?.cursor?.offset ?? 0}`, attempt.error || 'Bsale sync failed');
      return;
    }

    const data = attempt.data ?? {};
    state.bsale.batch_id = data?.resync_batch ?? state.bsale.batch_id ?? null;
    state.bsale.total_available = data?.summary?.total_available ?? state.bsale.total_available ?? null;
    state.bsale.cursor = data?.next_cursor ?? null;
    touchMetric(summary, step, {
      upserted: Number(summary.metrics?.[step]?.upserted ?? 0) + Number(data?.summary?.total_upserted ?? 0),
      available: state.bsale.total_available,
    });

    if (data?.partial) {
      if (!state.bsale.cursor) {
        await failOrRetry(admin, run, summary, step, `${target.connection_id}:${step}:missing_cursor`, 'Bsale returned partial without next_cursor');
      } else {
        await saveAndRequeue(admin, run.id, step, summary);
      }
    } else {
      await onComplete();
    }
    return;
  }
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
      .select('id, organization_id, owner_user_id, period, mode, source_type, source_connection_id, status, current_step, summary')
      .eq('id', runId)
      .single();
    const run = runRaw as unknown as SyncRunRow | null;
    if (runError || !run) throw new Error(runError?.message || 'Sync run not found');

    const summary = ensureSummary(run.summary);
    const state = summary.state as RunnerState;

    if (run.mode === 'reconcile_only') {
      await runReconcile(admin, run, summary);
      return new Response(JSON.stringify({ success: true, run_id: run.id, mode: run.mode, step: 'reconcile' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (run.mode === 'source') {
      if (!run.source_type || !run.source_connection_id) throw new Error('Source run has no connection scope');
      const target: SyncTarget = { source_type: run.source_type, connection_id: run.source_connection_id };
      const step = run.current_step || initialStep(target.source_type);
      await runConnectionChunk(admin, run, summary, target, step, async () => {
        clearTargetState(state, target);
        await finishRun(admin, run.id, summary);
      });
      return new Response(JSON.stringify({ success: true, run_id: run.id, mode: run.mode, step }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (run.mode !== 'full') throw new Error(`Unsupported Sync mode: ${run.mode}`);

    // Snapshot every active connector once. A connection added halfway through
    // the run is intentionally picked up on the next Sync, keeping this run
    // deterministic and its activity log auditable.
    if (!Array.isArray(state.full_connections)) {
      state.full_connections = await loadFullConnections(admin, run);
      state.full_connection_index = 0;
      state.full_connection_step = state.full_connections[0]
        ? initialStep(state.full_connections[0].source_type)
        : null;
      summary.plan = state.full_connections;
    }

    const connections = state.full_connections ?? [];
    const index = Number(state.full_connection_index ?? 0);

    if (index >= connections.length) {
      await runReconcile(admin, { ...run, current_step: 'reconcile' }, summary);
      return new Response(JSON.stringify({ success: true, run_id: run.id, mode: run.mode, step: 'reconcile' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const target = connections[index];
    const step = state.full_connection_step || initialStep(target.source_type);

    await runConnectionChunk(admin, run, summary, target, step, async () => {
      clearTargetState(state, target);
      state.full_connection_index = index + 1;
      const nextTarget = connections[index + 1];
      if (nextTarget) {
        const next = initialStep(nextTarget.source_type);
        state.full_connection_step = next;
        await saveAndRequeue(admin, run.id, next, summary);
      } else {
        state.full_connection_step = null;
        await saveAndRequeue(admin, run.id, 'reconcile', summary);
      }
    });

    return new Response(JSON.stringify({
      success: true,
      run_id: run.id,
      mode: run.mode,
      source_type: target.source_type,
      connection_id: target.connection_id,
      step,
    }), {
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
