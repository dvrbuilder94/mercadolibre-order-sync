import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CANONICAL_SYNC_STEPS } from '../_shared/sync-pipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
type SyncMode = 'full' | 'source' | 'reconcile_only';
type SourceType = 'meli' | 'shopify' | 'mercadopago' | 'bsale';

const SOURCE_INITIAL_STEP: Record<SourceType, string> = {
  meli: 'sync_meli_orders',
  shopify: 'sync_shopify_orders',
  mercadopago: 'sync_mercadopago_payments',
  bsale: 'sync_bsale',
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function validateSourceConnection(
  admin: any,
  sourceType: SourceType,
  connectionId: string,
  ownerUserId: string,
  organizationId: string,
) {
  let row: any = null;
  let error: any = null;

  if (sourceType === 'meli') {
    const result = await admin
      .from('meli_accounts')
      .select('id, organization_id, access_token')
      .eq('id', connectionId)
      .eq('user_id', ownerUserId)
      .maybeSingle();
    row = result.data;
    error = result.error;
    if (row && !row.access_token) throw new Error('Mercado Libre connection is not authenticated');
  } else if (sourceType === 'shopify') {
    const result = await admin
      .from('shopify_accounts')
      .select('id, organization_id, status, access_token')
      .eq('id', connectionId)
      .eq('user_id', ownerUserId)
      .maybeSingle();
    row = result.data;
    error = result.error;
    if (row && (!row.access_token || (row.status && row.status !== 'connected'))) {
      throw new Error('Shopify connection is not active');
    }
  } else if (sourceType === 'mercadopago') {
    const result = await admin
      .from('mercadopago_accounts')
      .select('id, organization_id, status')
      .eq('id', connectionId)
      .eq('user_id', ownerUserId)
      .maybeSingle();
    row = result.data;
    error = result.error;
    if (row && row.status !== 'connected') throw new Error('Mercado Pago connection is not active');
  } else {
    const result = await admin
      .from('bsale_accounts')
      .select('id, organization_id, status')
      .eq('id', connectionId)
      .eq('user_id', ownerUserId)
      .maybeSingle();
    row = result.data;
    error = result.error;
    if (row && row.status !== 'connected') throw new Error('Bsale connection is not active');
  }

  if (error || !row) throw new Error(`Connection not found for source ${sourceType}`);
  if (row.organization_id && row.organization_id !== organizationId) {
    throw new Error('Connection belongs to a different organization');
  }
}

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
    const mode = String(body?.mode ?? 'full') as SyncMode;
    const sourceType = mode === 'source' ? String(body?.source_type ?? '') as SourceType : null;
    const sourceConnectionId = mode === 'source' ? String(body?.connection_id ?? '') : null;

    if (!PERIOD_RE.test(period)) {
      return new Response(JSON.stringify({ error: 'period must use YYYY-MM' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!['full', 'source', 'reconcile_only'].includes(mode)) {
      return new Response(JSON.stringify({ error: 'Unsupported Sync mode' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (mode === 'source') {
      if (!sourceType || !Object.hasOwn(SOURCE_INITIAL_STEP, sourceType)) {
        return new Response(JSON.stringify({ error: 'source_type must be meli, shopify, mercadopago or bsale' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!isUuid(sourceConnectionId)) {
        return new Response(JSON.stringify({ error: 'connection_id must be a UUID for source mode' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
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

    if (mode === 'source') {
      await validateSourceConnection(
        admin,
        sourceType!,
        sourceConnectionId!,
        org.owner_user_id,
        org.id,
      );
    }

    const rawIdempotencyKey = (req.headers.get('idempotency-key') ?? '').trim();
    if (rawIdempotencyKey.length > 200) {
      return new Response(JSON.stringify({ error: 'Idempotency-Key is too long' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const idempotencyKey = rawIdempotencyKey || null;

    if (idempotencyKey) {
      const { data: byKeyRaw } = await admin
        .from('sync_runs')
        .select('id, status, current_step, period, mode, source_type, source_connection_id')
        .eq('organization_id', org.id)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      const byKey = byKeyRaw as any;
      if (byKey) {
        return new Response(JSON.stringify({
          run_id: byKey.id,
          status: byKey.status,
          current_step: byKey.current_step,
          mode: byKey.mode,
          source_type: byKey.source_type,
          connection_id: byKey.source_connection_id,
          reused: true,
          reason: 'idempotency_key',
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    let activeQuery = admin
      .from('sync_runs')
      .select('id, status, current_step, mode, source_type, source_connection_id')
      .eq('organization_id', org.id)
      .eq('period', period)
      .eq('mode', mode)
      .in('status', ['queued', 'running']);
    activeQuery = mode === 'source'
      ? activeQuery.eq('source_type', sourceType).eq('source_connection_id', sourceConnectionId)
      : activeQuery.is('source_type', null).is('source_connection_id', null);
    const { data: activeRaw } = await activeQuery.maybeSingle();
    const active = activeRaw as any;

    if (active) {
      return new Response(JSON.stringify({
        run_id: active.id,
        status: active.status,
        current_step: active.current_step,
        mode: active.mode,
        source_type: active.source_type,
        connection_id: active.source_connection_id,
        reused: true,
        reason: 'active_run',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const initialStep = mode === 'full'
      ? CANONICAL_SYNC_STEPS[0]
      : mode === 'reconcile_only'
        ? 'reconcile'
        : SOURCE_INITIAL_STEP[sourceType!];

    const { data: runRaw, error: insertError } = await admin
      .from('sync_runs')
      .insert({
        organization_id: org.id,
        owner_user_id: org.owner_user_id,
        period,
        mode,
        source_type: sourceType,
        source_connection_id: sourceConnectionId,
        trigger: 'manual',
        status: 'queued',
        current_step: initialStep,
        idempotency_key: idempotencyKey,
        requested_by: user.id,
        summary: {
          request: {
            mode,
            source_type: sourceType,
            connection_id: sourceConnectionId,
          },
          state: {},
          metrics: {},
        },
      })
      .select('id, status, current_step, mode, source_type, source_connection_id')
      .single();
    const run = runRaw as any;

    if (insertError || !run) {
      if ((insertError as any)?.code === '23505') {
        let recoveryQuery = admin
          .from('sync_runs')
          .select('id, status, current_step, mode, source_type, source_connection_id')
          .eq('organization_id', org.id);
        if (idempotencyKey) {
          recoveryQuery = recoveryQuery.eq('idempotency_key', idempotencyKey);
        } else {
          recoveryQuery = recoveryQuery
            .eq('period', period)
            .eq('mode', mode)
            .in('status', ['queued', 'running']);
          recoveryQuery = mode === 'source'
            ? recoveryQuery.eq('source_type', sourceType).eq('source_connection_id', sourceConnectionId)
            : recoveryQuery.is('source_type', null).is('source_connection_id', null);
        }
        const { data: recoveredRaw } = await recoveryQuery.limit(1).maybeSingle();
        const recovered = recoveredRaw as any;
        if (recovered) {
          return new Response(JSON.stringify({
            run_id: recovered.id,
            status: recovered.status,
            current_step: recovered.current_step,
            mode: recovered.mode,
            source_type: recovered.source_type,
            connection_id: recovered.source_connection_id,
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
      mode: run.mode,
      source_type: run.source_type,
      connection_id: run.source_connection_id,
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
