import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { getMeliAccount, getFreshAccessToken } from '../_shared/meli-account.ts';
import { resolveUserId } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type MercadoPagoCashPayment = {
  id: string;
  gross_amount: number;
  net_amount: number;
  fees_amount: number;
  date_approved: string;
  status: string;
  external_reference: string | null;
  payment_method_id: string | null;
  payment_type_id: string | null;
  money_release_date: string | null;
  raw_data: Record<string, unknown>;
};

const withChileOffset = (value: string, endOfDay: boolean) => {
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized += endOfDay ? 'T23:59:59' : 'T00:00:00';
  }
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return normalized;

  // Mercado Pago expects an offset. Resolve America/Santiago for the requested
  // date instead of hard-coding -04:00 (Chile changes to -03:00 in summer).
  const probe = new Date(`${normalized}Z`);
  const zoneName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    timeZoneName: 'longOffset',
  }).formatToParts(probe).find((part) => part.type === 'timeZoneName')?.value;
  const offset = zoneName?.replace('GMT', '') || '-04:00';
  return `${normalized}${offset}`;
};

async function searchMercadoPagoPayments(
  accessToken: string,
  range: 'date_approved' | 'date_last_updated',
  dateFrom: string,
  dateTo: string,
) {
  const payments: any[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = `https://api.mercadopago.com/v1/payments/search`
      + `?range=${range}&begin_date=${encodeURIComponent(withChileOffset(dateFrom, false))}`
      + `&end_date=${encodeURIComponent(withChileOffset(dateTo, true))}`
      + `&sort=${range}&criteria=desc&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`MercadoPago search ${range} falló (${response.status}): ${detail}`);
    }

    const body = await response.json();
    const results = body?.results ?? [];
    payments.push(...results);

    const total = Number(body?.paging?.total ?? results.length);
    offset += limit;
    if (offset >= total || results.length === 0 || offset >= 10_000) break;
  }

  return payments;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const {
      date_from,
      date_to,
      account_id: accountIdParam,
      user_id: userIdParam,
    } = await req.json().catch(() => ({}));

    if (!date_from || !date_to) {
      return new Response(
        JSON.stringify({ success: false, error: 'date_from y date_to son requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Allows both an authenticated user call from Tesorería and the service-role
    // pipeline with an explicit user_id, matching the other sync functions.
    const userId = await resolveUserId(req, supabase, userIdParam);
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autorizado. Por favor, recarga la página e inicia sesión nuevamente.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await getMeliAccount(supabase, userId, {
      accountId: accountIdParam,
      orderBy: 'created_at',
      maybeSingle: true,
    });

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ success: false, error: 'No se encontró cuenta de MercadoLibre conectada' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Refresh is centralized in cron-refresh-meli-tokens. Mercado Libre rotates
    // refresh_token on use, so refreshing independently here would create races.
    const accessToken = await getFreshAccessToken(supabase, meliAccount);

    // This is deliberately independent from orders: Mercado Pago is the source
    // of truth for cash. Order-driven sync alone can never discover a payment
    // that has no order in our database.
    const mpPayments: MercadoPagoCashPayment[] = [];
    const approvedResults = await searchMercadoPagoPayments(
      accessToken,
      'date_approved',
      date_from,
      date_to,
    );

    for (const p of approvedResults) {
      if (p.status !== 'approved') continue;

      const grossAmount = Number(p.transaction_amount ?? 0);
      const feeDetails = Array.isArray(p.fee_details) ? p.fee_details : [];
      const feesAmount = feeDetails.reduce(
        (sum: number, fee: any) => sum + Number(fee?.amount ?? 0),
        0,
      );
      const reportedNet = p.net_received_amount
        ?? p.transaction_details?.net_received_amount;
      // A zero is intentional when Mercado Pago has not reported a net yet;
      // do not manufacture cash from an estimate.
      const netAmount = Number(reportedNet ?? 0);

      mpPayments.push({
        id: String(p.id),
        gross_amount: grossAmount,
        net_amount: netAmount,
        fees_amount: feesAmount,
        date_approved: p.date_approved,
        status: p.status,
        external_reference: p.external_reference ?? null,
        payment_method_id: p.payment_method_id ?? null,
        payment_type_id: p.payment_type_id ?? null,
        money_release_date: p.money_release_date ?? null,
        raw_data: p,
      });
    }

    // meli_payment_details.payment_id is the real reconciliation key.
    const ids = mpPayments.map((payment) => payment.id);
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: rows, error } = await supabase
        .from('meli_payment_details')
        .select('payment_id')
        .in('payment_id', chunk);
      if (error) throw error;
      for (const row of rows ?? []) known.add(row.payment_id);
    }

    const candidates = mpPayments.filter((payment) => !known.has(payment.id));

    // Protect rows already linked through another workflow. A reconciliation
    // may exist even if its meli_payment_details row is missing, and this sync
    // must never downgrade ALLOCATED back to UNMATCHED.
    const existingStatuses = new Map<string, string | null>();
    const candidateIds = candidates.map((payment) => payment.id);
    for (let i = 0; i < candidateIds.length; i += 200) {
      const chunk = candidateIds.slice(i, i + 200);
      const { data: rows, error } = await supabase
        .from('payments')
        .select('external_payment_id, status')
        .in('external_payment_id', chunk);
      if (error) throw error;
      for (const row of rows ?? []) {
        if (row.external_payment_id) existingStatuses.set(row.external_payment_id, row.status);
      }
    }

    const unmatched = candidates.filter(
      (payment) => existingStatuses.get(payment.id) !== 'ALLOCATED',
    );
    const persistable = unmatched.filter((payment) => {
      const status = existingStatuses.get(payment.id);
      return status === undefined || status === 'UNMATCHED';
    });

    // Persist independent MP cash in the same provider-neutral ledger used by
    // Tesorería. Repeated syncs are safe, and sync-meli-payment-details will
    // later turn the same row into ALLOCATED when an order is found.
    let ingestedCount = 0;
    for (let i = 0; i < persistable.length; i += 200) {
      const chunk = persistable.slice(i, i + 200).map((payment) => ({
        user_id: userId,
        payment_provider: 'MERCADOPAGO',
        external_payment_id: payment.id,
        payment_date: payment.date_approved,
        gross_amount: payment.gross_amount,
        net_amount: payment.net_amount,
        fees_amount: payment.fees_amount,
        amount: payment.net_amount,
        status: 'UNMATCHED',
        reference: payment.external_reference
          ? `MP ${payment.id} · Ref ${payment.external_reference}`
          : `MP ${payment.id} · Sin venta asociada`,
        raw_data: {
          source: 'check-orphan-payments',
          account_id: meliAccount.id,
          mp_status: payment.status,
          external_reference: payment.external_reference,
          payment_method_id: payment.payment_method_id,
          payment_type_id: payment.payment_type_id,
          money_release_date: payment.money_release_date,
          mp_payment: payment.raw_data,
        },
      }));
      const { data: rows, error } = await supabase
        .from('payments')
        .upsert(chunk, { onConflict: 'external_payment_id' })
        .select('id');
      if (error) throw error;
      ingestedCount += rows?.length ?? chunk.length;
    }

    // Refunds are separate cash-out movements. Searching by date_last_updated
    // catches a July refund even when the original sale was approved in June.
    // Each increase in Mercado Pago's cumulative refunded amount becomes one
    // negative, idempotent ledger movement for the delta only.
    const updatedPayments = await searchMercadoPagoPayments(
      accessToken,
      'date_last_updated',
      date_from,
      date_to,
    );
    const reversalCandidates = updatedPayments.filter((payment: any) => {
      const refunded = Number(payment.transaction_amount_refunded ?? 0);
      return refunded > 0 || payment.status === 'charged_back';
    });

    let reversalCount = 0;
    let reversalAmount = 0;

    for (const payment of reversalCandidates) {
      const originalPaymentId = String(payment.id);
      const isChargeback = payment.status === 'charged_back';
      const cumulativeAmount = Number(
        Number(payment.transaction_amount_refunded ?? 0) > 0
          ? payment.transaction_amount_refunded
          : payment.transaction_amount,
      );
      if (!(cumulativeAmount > 0)) continue;

      const ledgerType = isChargeback ? 'MP_CHARGEBACK' : 'MP_REFUND';
      const prefix = isChargeback ? 'MP-CHARGEBACK' : 'MP-REFUND';
      // Refund and chargeback are two states of the same cumulative reversal.
      // Look at both prefixes so a payment that moves from refunded to charged
      // back never subtracts the same money twice.
      const priorRows: any[] = [];
      for (const priorPrefix of ['MP-REFUND', 'MP-CHARGEBACK']) {
        const { data: rows, error: priorError } = await supabase
          .from('payments')
          .select('id, raw_data')
          .eq('user_id', userId)
          .like('external_payment_id', `${priorPrefix}-${originalPaymentId}-%`);
        if (priorError) throw priorError;
        priorRows.push(...(rows ?? []));
      }

      const previousCumulative = priorRows.reduce(
        (max: number, row: any) => Math.max(
          max,
          Number(row.raw_data?.cumulative_reversal_amount ?? 0),
        ),
        0,
      );
      const delta = Math.round((cumulativeAmount - previousCumulative) * 100) / 100;
      if (!(delta > 0)) continue;

      const externalAdjustmentId =
        `${prefix}-${originalPaymentId}-${cumulativeAmount.toFixed(2)}`;
      const { data: adjustment, error: adjustmentError } = await supabase
        .from('payments')
        .upsert({
          user_id: userId,
          payment_provider: 'MERCADOPAGO',
          external_payment_id: externalAdjustmentId,
          payment_date: payment.date_last_updated || new Date().toISOString(),
          gross_amount: -delta,
          net_amount: -delta,
          fees_amount: 0,
          amount: -delta,
          status: isChargeback ? 'CHARGEBACK' : 'REFUND',
          reference: `${isChargeback ? 'Contracargo' : 'Devolución'} MP ${originalPaymentId}`,
          raw_data: {
            source: 'check-orphan-payments',
            ledger_type: ledgerType,
            account_id: meliAccount.id,
            original_payment_id: originalPaymentId,
            cumulative_reversal_amount: cumulativeAmount,
            reversal_delta: delta,
            mp_status: payment.status,
            mp_payment: payment,
          },
        }, { onConflict: 'external_payment_id' })
        .select('id')
        .single();
      if (adjustmentError) throw adjustmentError;

      // Mirror the original payment allocation so the refund is traceable to
      // the same sale(s). If the original payment is still orphaned, the
      // negative movement intentionally remains orphaned too.
      const { data: originalPayment, error: originalError } = await supabase
        .from('payments')
        .select('id')
        .eq('user_id', userId)
        .eq('external_payment_id', originalPaymentId)
        .maybeSingle();
      if (originalError) throw originalError;

      if (originalPayment) {
        const { data: originalLinks, error: linksError } = await supabase
          .from('payment_sales')
          .select('sale_id, allocated_amount')
          .eq('payment_id', originalPayment.id);
        if (linksError) throw linksError;

        const allocationTotal = (originalLinks ?? []).reduce(
          (sum: number, link: any) => sum + Math.abs(Number(link.allocated_amount ?? 0)),
          0,
        );
        for (const link of originalLinks ?? []) {
          const ratio = allocationTotal > 0
            ? Math.abs(Number(link.allocated_amount ?? 0)) / allocationTotal
            : 1 / Math.max(originalLinks?.length ?? 1, 1);
          const allocated = -Math.round(delta * ratio * 100) / 100;
          const { error: linkError } = await supabase
            .from('payment_sales')
            .upsert({
              payment_id: adjustment.id,
              sale_id: link.sale_id,
              allocated_amount: allocated,
            }, { onConflict: 'payment_id,sale_id' });
          if (linkError) throw linkError;
        }
      }

      reversalCount++;
      reversalAmount += delta;
    }

    const unmatchedAmount = unmatched.reduce(
      (sum, payment) => sum + payment.net_amount,
      0,
    );
    const compact = (payment: MercadoPagoCashPayment) => ({
      id: payment.id,
      gross_amount: payment.gross_amount,
      net_amount: payment.net_amount,
      fees_amount: payment.fees_amount,
      date_approved: payment.date_approved,
      status: payment.status,
      external_reference: payment.external_reference,
    });

    return new Response(
      JSON.stringify({
        success: true,
        totalChecked: mpPayments.length,
        unmatchedCount: unmatched.length,
        unmatchedAmount,
        ingestedCount,
        reversalCount,
        reversalAmount,
        unmatched: unmatched.slice(0, 100).map(compact),
        payments: mpPayments.slice(0, 500).map((payment) => ({
          ...compact(payment),
          matched: known.has(payment.id) || existingStatuses.get(payment.id) === 'ALLOCATED',
        })),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in check-orphan-payments:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
