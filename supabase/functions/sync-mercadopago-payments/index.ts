import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveUserId } from '../_shared/auth.ts';
import {
  MP_API, getMercadoPagoAccount, getFreshMercadoPagoToken,
} from '../_shared/mercadopago-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// Mercado Pago exige offset en las fechas; Chile alterna entre -04:00 y -03:00.
const withChileOffset = (value: string, endOfDay: boolean) => {
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized += endOfDay ? 'T23:59:59' : 'T00:00:00';
  }
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return normalized;
  const zoneName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', timeZoneName: 'longOffset',
  }).formatToParts(new Date(`${normalized}Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  return `${normalized}${zoneName?.replace('GMT', '') || '-04:00'}`;
};

async function searchPayments(
  accessToken: string, dateFrom: string, dateTo: string,
): Promise<any[]> {
  const results: any[] = [];
  const limit = 50;
  let offset = 0;
  while (true) {
    const url = `${MP_API}/v1/payments/search?`
      + new URLSearchParams({
        range: 'date_created',
        begin_date: withChileOffset(dateFrom, false),
        end_date: withChileOffset(dateTo, true),
        sort: 'date_created',
        criteria: 'desc',
        limit: String(limit),
        offset: String(offset),
      });
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Mercado Pago /payments/search falló (${response.status}): ${detail}`);
    }
    const body = await response.json();
    const page = body?.results ?? [];
    results.push(...page);
    const total = Number(body?.paging?.total ?? page.length);
    offset += limit;
    if (page.length === 0 || offset >= total || offset >= 10_000) break;
  }
  return results;
}

// Solo lectura: este sync usa exclusivamente endpoints GET de Mercado Pago.
// Nunca crea, modifica ni reembolsa pagos.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    );
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { date_from, date_to, account_id, user_id: userIdParam } =
      await req.json().catch(() => ({}));
    if (!date_from || !date_to) {
      return json({ success: false, error: 'date_from y date_to son requeridos' }, 400);
    }

    const userId = await resolveUserId(req, supabase, userIdParam);
    if (!userId) return json({ success: false, error: 'No autorizado' }, 401);

    const account = await getMercadoPagoAccount(admin, userId, account_id);
    if (!account) {
      return json({ success: false, error: 'No hay cuenta de Mercado Pago conectada' }, 400);
    }
    const accessToken = await getFreshMercadoPagoToken(admin, account);

    const payments = await searchPayments(accessToken, date_from, date_to);

    let approvedCount = 0;
    let reversalCount = 0;
    let reversalAmount = 0;
    const rows: any[] = [];

    for (const payment of payments) {
      if (payment.status !== 'approved') continue;
      approvedCount++;

      const feeDetails = Array.isArray(payment.fee_details) ? payment.fee_details : [];
      const feesAmount = feeDetails.reduce(
        (sum: number, fee: any) => sum + Number(fee?.amount ?? 0), 0,
      );
      const netAmount = Number(
        payment.net_received_amount ?? payment.transaction_details?.net_received_amount ?? 0,
      );

      rows.push({
        user_id: userId,
        payment_provider: 'MERCADOPAGO',
        external_payment_id: String(payment.id),
        payment_date: payment.date_approved ?? payment.date_created,
        gross_amount: Number(payment.transaction_amount ?? 0),
        net_amount: netAmount,
        fees_amount: feesAmount,
        amount: netAmount,
        status: 'UNMATCHED',
        reference: payment.external_reference
          ? `MP ${payment.id} · Ref ${payment.external_reference}`
          : `MP ${payment.id}`,
        raw_data: {
          source: 'sync-mercadopago-payments',
          mp_account_id: account.id,
          mp_status: payment.status,
          external_reference: payment.external_reference,
          payment_method_id: payment.payment_method_id,
          payment_type_id: payment.payment_type_id,
          installments: payment.installments,
          money_release_date: payment.money_release_date,
          charges_details: payment.charges_details ?? null,
          mp_payment: payment,
        },
      });
    }

    // Nunca degradamos a UNMATCHED un pago ya conciliado por otro flujo.
    const allocated = new Set<string>();
    const ids = rows.map((row) => row.external_payment_id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: existing, error } = await admin
        .from('payments')
        .select('external_payment_id, status')
        .in('external_payment_id', ids.slice(i, i + 200));
      if (error) throw error;
      for (const row of existing ?? []) {
        if (row.status && row.status !== 'UNMATCHED') allocated.add(row.external_payment_id!);
      }
    }

    const persistable = rows.filter((row) => !allocated.has(row.external_payment_id));
    let ingestedCount = 0;
    for (let i = 0; i < persistable.length; i += 200) {
      const { data, error } = await admin
        .from('payments')
        .upsert(persistable.slice(i, i + 200), { onConflict: 'external_payment_id' })
        .select('id');
      if (error) throw error;
      ingestedCount += data?.length ?? 0;
    }

    // Devoluciones y contracargos: movimientos negativos idempotentes por el
    // delta del monto acumulado reembolsado, igual que en check-orphan-payments.
    for (const payment of payments) {
      const refunded = Number(payment.transaction_amount_refunded ?? 0);
      const isChargeback = payment.status === 'charged_back';
      if (!(refunded > 0) && !isChargeback) continue;

      const cumulative = refunded > 0 ? refunded : Number(payment.transaction_amount ?? 0);
      if (!(cumulative > 0)) continue;

      const prefix = isChargeback ? 'MP-CHARGEBACK' : 'MP-REFUND';
      const priorRows: any[] = [];
      for (const priorPrefix of ['MP-REFUND', 'MP-CHARGEBACK']) {
        const { data, error } = await admin
          .from('payments')
          .select('raw_data')
          .eq('user_id', userId)
          .like('external_payment_id', `${priorPrefix}-${payment.id}-%`);
        if (error) throw error;
        priorRows.push(...(data ?? []));
      }
      const previous = priorRows.reduce(
        (max: number, row: any) => Math.max(max, Number(row.raw_data?.cumulative_reversal_amount ?? 0)),
        0,
      );
      const delta = Math.round((cumulative - previous) * 100) / 100;
      if (!(delta > 0)) continue;

      const { error: adjustmentError } = await admin.from('payments').upsert({
        user_id: userId,
        payment_provider: 'MERCADOPAGO',
        external_payment_id: `${prefix}-${payment.id}-${cumulative.toFixed(2)}`,
        payment_date: payment.date_last_updated || new Date().toISOString(),
        gross_amount: -delta,
        net_amount: -delta,
        fees_amount: 0,
        amount: -delta,
        status: isChargeback ? 'CHARGEBACK' : 'REFUND',
        reference: `${isChargeback ? 'Contracargo' : 'Devolución'} MP ${payment.id}`,
        raw_data: {
          source: 'sync-mercadopago-payments',
          ledger_type: isChargeback ? 'MP_CHARGEBACK' : 'MP_REFUND',
          mp_account_id: account.id,
          original_payment_id: String(payment.id),
          cumulative_reversal_amount: cumulative,
          reversal_delta: delta,
          mp_status: payment.status,
          mp_payment: payment,
        },
      }, { onConflict: 'external_payment_id' });
      if (adjustmentError) throw adjustmentError;

      reversalCount++;
      reversalAmount += delta;
    }

    await admin
      .from('mercadopago_accounts')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', account.id);

    return json({
      success: true,
      totalFetched: payments.length,
      approvedCount,
      ingestedCount,
      reversalCount,
      reversalAmount,
    });
  } catch (error) {
    console.error('sync-mercadopago-payments error:', error);
    return json({ success: false, error: error instanceof Error ? error.message : 'Error interno' }, 500);
  }
});
