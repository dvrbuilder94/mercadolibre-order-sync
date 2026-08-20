import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isInternalRequest, unauthorizedJson } from '../_shared/internal-request.ts';
import { CANONICAL_SYNC_STEPS } from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cron-secret, x-client-info, apikey, content-type',
};

// Automatic scheduler/sweeper for canonical Sync.
//
// It no longer executes MELI/MP/Bsale/reconcile itself. Manual Sync and cron
// both create/continue `sync_runs`, which are processed exclusively by
// `sync-runner`. This prevents the two entry points from drifting apart.

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

    // Preserve the existing source scope: any owner with connected MELI or
    // Bsale data should receive catch-up runs. Deduplicate at owner level.
    const [{ data: meliRows, error: meliError }, { data: bsaleRows, error: bsaleError }] = await Promise.all([
      admin.from('meli_accounts').select('user_id').not('access_token', 'is', null),
      admin.from('bsale_accounts').select('user_id').eq('status', 'connected'),
    ]);
    if (meliError) throw new Error(`Failed to list MELI owners: ${meliError.message}`);
    if (bsaleError) throw new Error(`Failed to list Bsale owners: ${bsaleError.message}`);

    const ownerUserIds = Array.from(new Set([
      ...((meliRows ?? []).map((row: any) => String(row.user_id))),
      ...((bsaleRows ?? []).map((row: any) => String(row.user_id))),
    ]));

    let created = 0;
    let requeued = 0;
    let leased = 0;
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
          const { data: activeRaw, error: activeError } = await admin
            .from('sync_runs')
            .select('id, status, current_step, runner_lease_until')
            .eq('organization_id', org.id)
            .eq('period', period)
            .eq('mode', 'full')
            .in('status', ['queued', 'running'])
            .maybeSingle();
          if (activeError) throw activeError;
          const active = activeRaw as any;

          if (active) {
            if (active.status === 'queued' || leaseIsStale(active.runner_lease_until)) {
              const { error: queueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: active.id });
              if (queueError) throw queueError;
              requeued++;
              detail.push({ owner_user_id: ownerUserId, period, run_id: active.id, action: 'requeued' });
            } else {
              leased++;
              detail.push({ owner_user_id: ownerUserId, period, run_id: active.id, action: 'already_running' });
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
              trigger: 'cron',
              status: 'queued',
              current_step: CANONICAL_SYNC_STEPS[0],
              summary: { state: {}, metrics: {} },
            })
            .select('id')
            .single();
          const run = runRaw as any;

          if (insertError || !run) {
            // A manual request may have won the race after our active lookup.
            if ((insertError as any)?.code === '23505') {
              const { data: racedRaw } = await admin
                .from('sync_runs')
                .select('id, runner_lease_until')
                .eq('organization_id', org.id)
                .eq('period', period)
                .eq('mode', 'full')
                .in('status', ['queued', 'running'])
                .limit(1)
                .maybeSingle();
              const raced = racedRaw as any;
              if (raced && leaseIsStale(raced.runner_lease_until)) {
                const { error: queueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: raced.id });
                if (queueError) throw queueError;
                requeued++;
                detail.push({ owner_user_id: ownerUserId, period, run_id: raced.id, action: 'race_requeued' });
                continue;
              }
              if (raced) {
                leased++;
                detail.push({ owner_user_id: ownerUserId, period, run_id: raced.id, action: 'race_already_running' });
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
          detail.push({ owner_user_id: ownerUserId, period, run_id: run.id, action: 'created' });
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
