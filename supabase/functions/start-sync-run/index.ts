import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CANONICAL_SYNC_STEPS } from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const period = String(body?.period ?? '');
    const mode = String(body?.mode ?? 'full');

    if (!PERIOD_RE.test(period)) {
      return new Response(JSON.stringify({ error: 'period must use YYYY-MM' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (mode !== 'full') {
      return new Response(JSON.stringify({ error: 'Only full sync mode is supported for now' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: membershipRaw, error: membershipError } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const membership = membershipRaw as any;

    if (membershipError || !membership) {
      return new Response(JSON.stringify({ error: 'Organization not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!['owner', 'admin'].includes(String(membership.role))) {
      return new Response(JSON.stringify({ error: 'Only organization admins can start Sync' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: orgRaw, error: orgError } = await admin
      .from('organizations')
      .select('id, owner_user_id')
      .eq('id', membership.organization_id)
      .single();
    const org = orgRaw as any;

    if (orgError || !org?.owner_user_id) {
      return new Response(JSON.stringify({ error: 'Organization owner not found' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rawIdempotencyKey = (req.headers.get('idempotency-key') ?? '').trim();
    if (rawIdempotencyKey.length > 200) {
      return new Response(JSON.stringify({ error: 'Idempotency-Key is too long' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const idempotencyKey = rawIdempotencyKey || null;

    // Request-level idempotency: return the exact prior run for a repeated key.
    if (idempotencyKey) {
      const { data: byKeyRaw } = await admin
        .from('sync_runs')
        .select('id, status, current_step, period, mode')
        .eq('organization_id', org.id)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      const byKey = byKeyRaw as any;
      if (byKey) {
        return new Response(JSON.stringify({
          run_id: byKey.id,
          status: byKey.status,
          current_step: byKey.current_step,
          reused: true,
          reason: 'idempotency_key',
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Product lock: manual + cron must not run the same full period at once.
    const { data: activeRaw } = await admin
      .from('sync_runs')
      .select('id, status, current_step')
      .eq('organization_id', org.id)
      .eq('period', period)
      .eq('mode', mode)
      .in('status', ['queued', 'running'])
      .maybeSingle();
    const active = activeRaw as any;

    if (active) {
      return new Response(JSON.stringify({
        run_id: active.id,
        status: active.status,
        current_step: active.current_step,
        reused: true,
        reason: 'active_run',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: runRaw, error: insertError } = await admin
      .from('sync_runs')
      .insert({
        organization_id: org.id,
        owner_user_id: org.owner_user_id,
        period,
        mode,
        trigger: 'manual',
        status: 'queued',
        current_step: CANONICAL_SYNC_STEPS[0],
        idempotency_key: idempotencyKey,
        requested_by: user.id,
        summary: { state: {}, metrics: {} },
      })
      .select('id, status, current_step')
      .single();
    const run = runRaw as any;

    if (insertError || !run) {
      // Race-safe fallback for either the active-run unique index or the
      // idempotency unique index.
      if ((insertError as any)?.code === '23505') {
        let recoveryQuery = admin
          .from('sync_runs')
          .select('id, status, current_step')
          .eq('organization_id', org.id);
        recoveryQuery = idempotencyKey
          ? recoveryQuery.eq('idempotency_key', idempotencyKey)
          : recoveryQuery.eq('period', period).eq('mode', mode).in('status', ['queued', 'running']);
        const { data: recoveredRaw } = await recoveryQuery.limit(1).maybeSingle();
        const recovered = recoveredRaw as any;
        if (recovered) {
          return new Response(JSON.stringify({
            run_id: recovered.id,
            status: recovered.status,
            current_step: recovered.current_step,
            reused: true,
            reason: 'unique_lock',
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      throw new Error((insertError as any)?.message || 'Failed to create Sync run');
    }

    const { error: enqueueError } = await admin.rpc('enqueue_sync_runner', { p_run_id: run.id });
    if (enqueueError) {
      await admin.from('sync_runs').update({
        status: 'error',
        finished_at: new Date().toISOString(),
        error: { stage: 'enqueue', message: enqueueError.message },
      }).eq('id', run.id);
      throw new Error(`Failed to enqueue Sync runner: ${enqueueError.message}`);
    }

    return new Response(JSON.stringify({
      run_id: run.id,
      status: run.status,
      current_step: run.current_step,
      reused: false,
    }), {
      status: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[start-sync-run]', error);
    return new Response(JSON.stringify({ error: error?.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
