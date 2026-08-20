import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isInternalRequest, unauthorizedJson } from '../_shared/internal-request.ts';
import { CANONICAL_SYNC_STEPS } from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cron-secret, x-client-info, apikey, content-type',
};

// Automatic scheduler/sweeper for canonical Sync.
// It only schedules/requeues runs; `sync-runner` owns all source work.

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

function leaseIsStale(value: string | null | undefined) {
  if (!value) return true;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date <= new Date();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: corsHeaders });
  if (!await isInternalRequest(req)) return unauthorizedJson(corsHeaders);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  try {
    const currentPeriod = chilePeriodNow();
    const periods = [currentPeriod, shiftPeriod(currentPeriod, -1)];

    // Any tenant owner with at least one active source participates in catch-up.
    const [meliResult, bsaleResult, shopifyResult, mpResult] = await Promise.all([
      admin.from('meli_accounts').select('user_id').not('access_token', 'is', null),
      admin.from('bsale_accounts').select('user_id').eq('status', 'connected'),
      admin.from('shopify_accounts').select('user_id, status').not('access_token', 'is', null),
      admin.from('mercadopago_accounts').select('user_id').eq('status', 'connected'),
    ]);
    if (meliResult.error) throw new Error(`Failed to list MELI owners: ${meliResult.error.message}`);
    if (bsaleResult.error) throw new Error(`Failed to list Bsale owners: ${bsaleResult.error.message}`);
    if (shopifyResult.error) throw new Error(`Failed to list Shopify owners: ${shopifyResult.error.message}`);
    if (mpResult.error) throw new Error(`Failed to list Mercado Pago owners: ${mpResult.error.message}`);

    const shopifyOwners = (shopifyResult.data ?? [])
      .filter((row: any) => !row.status || row.status === 'connected')
      .map((row: any) => String(row.user_id));

    const ownerUserIds = Array.from(new Set([
      ...((meliResult.data ?? []).map((row: any) => String(row.user_id))),
      ...((bsaleResult.data ?? []).map((row: any) => String(row.user_id))),
      ...shopifyOwners,
      ...((mpResult.data ?? []).map((row: any) => String(row.user_id))),
    ]));

    let created = 0;
    let requeued = 0;
    let leased = 0;
    let blockedByManual = 0;
    let skippedNoOrg = 0;
    let errors = 0;
    const detail: any[] = [];

    for (const ownerUserId of ownerUserIds) {
      const { data: orgRaw, error: orgError } = await admin
        .from('organizations')
        .select('id, owner_user_id')
        .eq('owner_user_id', ownerUserId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      const org = orgRaw as any;

      if (orgError) {
        errors++;
        detail.push({ owner_user_id: ownerUserId, error: orgError.message });
        continue;
      }
      if (!org) {
        skippedNoOrg++;
        detail.push({ owner_user_id: ownerUserId, skipped: 'no_organization' });
        continue;
      }

      for (const period of periods) {
        try {
          // Respect every active scope. A manual source/reconcile run must not
          // be overlapped by the cron's full run. The DB trigger enforces the
          // same rule atomically; this pre-check gives clearer scheduler logs.
          const { data: activeRows, error: activeError } = await admin
            .from('sync_runs')
            .select('id, mode, status, current_step, runner_lease_until')
            .eq('organization_id', org.id)
            .eq('period', period)
            .in('status', ['queued', 'running'])
            .order('started_at', { ascending: true });
          if (activeError) throw activeError;

          const active = (activeRows ?? [])[0] as any;
          if (active) {
            // Sweeper: revive any queued/stale canonical run regardless of mode.
            if (active.status === 'queued' || leaseIsStale(active.runner_lease_until)) {
              const { error: queueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: active.id });
              if (queueError) throw queueError;
              requeued++;
              detail.push({ owner_user_id: ownerUserId, period, run_id: active.id, mode: active.mode, action: 'requeued_existing' });
            } else if (active.mode === 'full') {
              leased++;
              detail.push({ owner_user_id: ownerUserId, period, run_id: active.id, action: 'full_already_running' });
            } else {
              blockedByManual++;
              detail.push({ owner_user_id: ownerUserId, period, run_id: active.id, mode: active.mode, action: 'blocked_by_active_manual_scope' });
            }
            continue;
          }

          const { data: runRaw, error: insertError } = await admin
            .from('sync_runs')
            .insert({
              organization_id: org.id,
              owner_user_id: ownerUserId,
              period,
              mode: 'full',
              source_type: null,
              source_connection_id: null,
              trigger: 'cron',
              status: 'queued',
              current_step: CANONICAL_SYNC_STEPS[0],
              summary: { state: {}, metrics: {} },
            })
            .select('id')
            .single();
          const run = runRaw as any;

          if (insertError || !run) {
            // DB-level scope guard may win a race with a manual request.
            if ((insertError as any)?.code === '23505') {
              const { data: racedRows } = await admin
                .from('sync_runs')
                .select('id, mode, status, runner_lease_until')
                .eq('organization_id', org.id)
                .eq('period', period)
                .in('status', ['queued', 'running'])
                .order('started_at', { ascending: true })
                .limit(1);
              const raced = (racedRows ?? [])[0] as any;
              if (raced && (raced.status === 'queued' || leaseIsStale(raced.runner_lease_until))) {
                const { error: queueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: raced.id });
                if (queueError) throw queueError;
                requeued++;
                detail.push({ owner_user_id: ownerUserId, period, run_id: raced.id, mode: raced.mode, action: 'race_requeued' });
                continue;
              }
              if (raced) {
                blockedByManual++;
                detail.push({ owner_user_id: ownerUserId, period, run_id: raced.id, mode: raced.mode, action: 'race_blocked' });
                continue;
              }
            }
            throw new Error((insertError as any)?.message || 'Failed to create cron Sync run');
          }

          const { error: queueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: run.id });
          if (queueError) {
            await admin.from('sync_runs').update({
              status: 'error',
              finished_at: new Date().toISOString(),
              error: { stage: 'cron_enqueue', message: queueError.message },
            }).eq('id', run.id);
            throw queueError;
          }

          created++;
          detail.push({ owner_user_id: ownerUserId, period, run_id: run.id, action: 'created_full' });
        } catch (error: any) {
          errors++;
          console.error('[cron-pipeline-sync]', ownerUserId, period, error);
          detail.push({ owner_user_id: ownerUserId, period, error: error?.message || String(error) });
        }
      }
    }

    console.log('[cron-pipeline-sync]', {
      owners: ownerUserIds.length,
      periods,
      created,
      requeued,
      leased,
      blockedByManual,
      skippedNoOrg,
      errors,
    });

    return new Response(JSON.stringify({
      success: errors === 0,
      owners: ownerUserIds.length,
      periods,
      created,
      requeued,
      already_running: leased,
      blocked_by_manual: blockedByManual,
      skipped_no_org: skippedNoOrg,
      errors,
      detail,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[cron-pipeline-sync] fatal:', error);
    return new Response(JSON.stringify({ error: error?.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
