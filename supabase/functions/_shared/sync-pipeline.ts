import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chileMonthIsoRange, chileMonthUnixRange } from './chile-date.ts';

// Motor canónico de Sync.
//
// Este módulo contiene los pasos y loops de negocio que antes vivían dentro de
// cron-pipeline-sync. El cron sigue decidiendo QUÉ tenants/períodos ejecutar;
// este módulo decide CÓMO se ejecuta cada paso. El futuro sync-runner manual
// debe reutilizar estas mismas funciones en vez de duplicar lógica.

export const CANONICAL_SYNC_STEPS = [
  'sync_meli_orders',
  'sync_payments',
  'sync_mp_cash',
  'sync_bsale',
  'enrich_ruts',
  'reconcile',
] as const;

export type CanonicalSyncStep = typeof CANONICAL_SYNC_STEPS[number];

export interface MeliSyncAccount {
  id: string;
  user_id: string;
}

export interface PipelineStepResult {
  step: string;
  user_id: string | null;
  period: string | null;
  ok: boolean;
  detail?: any;
}

export async function callSyncWorker(
  admin: SupabaseClient,
  name: string,
  body: Record<string, unknown>,
) {
  const { data, error } = await admin.functions.invoke(name, { body });
  if (error) {
    let detail: any = null;
    try { detail = await (error as any)?.context?.json?.(); } catch { /* ignore */ }
    throw new Error(detail?.error || detail?.message || error.message || `${name} failed`);
  }
  return data;
}

export async function recordPipelineStep(
  admin: SupabaseClient,
  step: CanonicalSyncStep,
  userId: string | null,
  meliAccountId: string | null,
  period: string | null,
  fn: () => Promise<any>,
): Promise<PipelineStepResult> {
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
    console.error(`[sync-pipeline] ${step} failed (user=${userId}, period=${period}):`, detail.error);
    if (row) {
      await admin.from('pipeline_sync_runs')
        .update({ status: 'error', finished_at: new Date().toISOString(), detail })
        .eq('id', row.id);
    }
    return { step, user_id: userId, period, ok: false, detail };
  }
}

export async function syncOrdersLoop(
  admin: SupabaseClient,
  acc: MeliSyncAccount,
  dateFrom: string,
  dateTo: string,
  timeLeft: () => boolean,
  startOffset = 0,
) {
  let totalSynced = 0;
  let round = 0;
  let partial = true;
  let cursorOffset = startOffset;
  let nextCursor: { offset: number } | null = { offset: startOffset };
  let cursorStalled = false;

  while (partial && round < 5 && timeLeft()) {
    round++;
    const data = await callSyncWorker(admin, 'sync-meli-orders', {
      date_from: dateFrom,
      date_to: dateTo,
      max_pages: 50,
      start_offset: cursorOffset,
      account_id: acc.id,
      user_id: acc.user_id,
    });

    totalSynced += data?.synced ?? 0;
    partial = !!data?.partial;

    if (!partial) {
      nextCursor = null;
      break;
    }

    const rawNextOffset = Number(data?.next_cursor?.offset);
    if (!Number.isSafeInteger(rawNextOffset) || rawNextOffset < 0) {
      // A partial response without a usable cursor must never replay offset 0
      // silently. Surface the unfinished state so the future runner can stop
      // and report it instead of looping forever.
      cursorStalled = true;
      nextCursor = { offset: cursorOffset };
      break;
    }

    nextCursor = { offset: rawNextOffset };
    if (rawNextOffset === cursorOffset) {
      // Same offset is valid after a transient page/write error, but retry it
      // at most once inside this loop. Persistence/retry policy belongs to the
      // orchestrator, not an unbounded worker loop.
      if (cursorStalled) break;
      cursorStalled = true;
    } else {
      cursorStalled = false;
    }
    cursorOffset = rawNextOffset;
  }

  return {
    rounds: round,
    totalSynced,
    partial,
    nextCursor,
    cursorStalled: partial && cursorStalled,
  };
}

export async function syncPaymentsLoop(
  admin: SupabaseClient,
  acc: MeliSyncAccount,
  dateFrom: string,
  dateTo: string,
  timeLeft: () => boolean,
) {
  let totalLinked = 0;
  let round = 0;
  let remaining = 0;

  while (round < 10 && timeLeft()) {
    round++;
    const data = await callSyncWorker(admin, 'sync-meli-payment-details', {
      date_from: dateFrom,
      date_to: dateTo,
      limit: 50,
      account_id: acc.id,
      user_id: acc.user_id,
    });
    totalLinked += data?.paymentsLinked ?? 0;
    remaining = data?.remaining ?? 0;
    if (remaining === 0 || (data?.updated ?? 0) === 0) break;
  }

  return { rounds: round, totalLinked, remaining };
}

export async function syncMercadoPagoCash(
  admin: SupabaseClient,
  acc: MeliSyncAccount,
  dateFrom: string,
  dateTo: string,
) {
  return callSyncWorker(admin, 'check-orphan-payments', {
    date_from: dateFrom,
    date_to: dateTo,
    account_id: acc.id,
    user_id: acc.user_id,
  });
}

export async function enrichRutsLoop(
  admin: SupabaseClient,
  acc: MeliSyncAccount,
  dateFrom: string,
  dateTo: string,
  timeLeft: () => boolean,
) {
  let totalEnriched = 0;
  let round = 0;
  let remaining = 0;

  while (round < 20 && timeLeft()) {
    round++;
    const data = await callSyncWorker(admin, 'enrich-meli-billing', {
      date_from: dateFrom,
      date_to: dateTo,
      account_id: acc.id,
      user_id: acc.user_id,
    });
    totalEnriched += data?.enriched ?? 0;
    remaining = data?.remaining ?? 0;
    if (remaining === 0 || (data?.enriched ?? 0) === 0) break;
  }

  return { rounds: round, totalEnriched, remaining };
}

// Checkpoint Bsale siempre en backend, scope (user_id, period).
export async function syncBsaleLoop(
  admin: SupabaseClient,
  userId: string,
  period: string,
  timeLeft: () => boolean,
) {
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
  let totalUpserted = 0;
  let rounds = 0;

  while (rounds < 8 && timeLeft()) {
    rounds++;
    const data = await callSyncWorker(admin, 'sync-bsale-docs', {
      date_from: dateFrom,
      date_to: dateTo,
      max_pages: 20,
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
        user_id: userId,
        period,
        cursor,
        batch_id: batchId,
        total_available: totalAvailable,
        updated_at: new Date().toISOString(),
      });
    }

    if (!data?.partial) break;
  }

  if (!cursor) {
    await admin.from('bsale_sync_checkpoints')
      .delete()
      .eq('user_id', userId)
      .eq('period', period);
  }

  return { rounds, totalUpserted, resumePending: !!cursor };
}

export async function reconcilePeriod(
  admin: SupabaseClient,
  userId: string,
  period: string,
) {
  const { from: dateFrom, to: dateTo } = chileMonthIsoRange(period);
  return callSyncWorker(admin, 'auto-reconcile', {
    date_from: dateFrom,
    date_to: dateTo,
    user_id: userId,
  });
}
