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
    let offset = 0;
    const limit = 50;
    while (true) {
      const url = `https://api.mercadopago.com/v1/payments/search`
        + `?range=date_approved&begin_date=${encodeURIComponent(withChileOffset(date_from, false))}`
        + `&end_date=${encodeURIComponent(withChileOffset(date_to, true))}`
        + `&sort=date_approved&criteria=desc&limit=${limit}&offset=${offset}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`MercadoPago search falló (${resp.status}): ${errText}`);
      }

      const body = await resp.json();
      const results = body?.results ?? [];
      for (const p of results) {
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

      const total = body?.paging?.total ?? results.length;
      offset += limit;
      if (offset >= total || results.length === 0 || offset > 5000) break;
    }

    if (mpPayments.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          totalChecked: 0,
          unmatchedCount: 0,
          unmatchedAmount: 0,
          ingestedCount: 0,
          unmatched: [],
          payments: [],
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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

    const unmatched = mpPayments.filter((payment) => !known.has(payment.id));

    // Persist independent MP cash in the same provider-neutral ledger used by
    // Tesorería. Repeated syncs are safe, and sync-meli-payment-details will
    // later turn the same row into ALLOCATED when an order is found.
    let ingestedCount = 0;
    for (let i = 0; i < unmatched.length; i += 200) {
      const chunk = unmatched.slice(i, i + 200).map((payment) => ({
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
        unmatched: unmatched.slice(0, 100).map(compact),
        payments: mpPayments.slice(0, 500).map((payment) => ({
          ...compact(payment),
          matched: known.has(payment.id),
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
