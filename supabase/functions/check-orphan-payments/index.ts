import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { getMeliAccount, getFreshAccessToken } from '../_shared/meli-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autorizado. Por favor, recarga la página e inicia sesión nuevamente.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { date_from, date_to, account_id: accountIdParam } = await req.json().catch(() => ({}));
    if (!date_from || !date_to) {
      return new Response(
        JSON.stringify({ success: false, error: 'date_from y date_to son requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await getMeliAccount(supabase, user.id, {
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

    // Refresh se centraliza en cron-refresh-meli-tokens (MELI rota el
    // refresh_token en cada uso; refrescar aquí también generaría una carrera).
    const accessToken = await getFreshAccessToken(supabase, meliAccount);

    // Pulls every approved payment directly from MercadoPago for the period —
    // independent of our own orders. sync-meli-payment-details only ever looks
    // up payments *from* an order (for (const order of batch) ...), so a
    // payment that exists in MercadoPago with no matching order in our DB is
    // invisible to the rest of the pipeline by construction. This is the only
    // place that asks MercadoPago directly "what came in", instead of asking
    // our own orders "did you get paid".
    const mpPayments: { id: string; amount: number; date_approved: string; status: string; external_reference: string | null }[] = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const url = `https://api.mercadopago.com/v1/payments/search`
        + `?range=date_approved&begin_date=${encodeURIComponent(date_from + '.000-04:00')}`
        + `&end_date=${encodeURIComponent(date_to + '.000-04:00')}`
        + `&sort=date_approved&criteria=desc&limit=${limit}&offset=${offset}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`MercadoPago search falló (${resp.status}): ${errText}`);
      }
      const body = await resp.json();
      const results = body?.results ?? [];
      for (const p of results) {
        if (p.status !== 'approved') continue; // rejected/pending no es plata recibida
        mpPayments.push({
          id: String(p.id),
          amount: p.transaction_amount,
          date_approved: p.date_approved,
          status: p.status,
          external_reference: p.external_reference ?? null,
        });
      }
      const total = body?.paging?.total ?? results.length;
      offset += limit;
      if (offset >= total || results.length === 0 || offset > 5000) break; // tope de seguridad
    }

    if (mpPayments.length === 0) {
      return new Response(
        JSON.stringify({ success: true, totalChecked: 0, unmatchedCount: 0, unmatchedAmount: 0, unmatched: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // payment_id es la clave real de deduplicación en meli_payment_details
    // (ver supabase/migrations/20260618140000_fix_payment_details_multi_payment_orders.sql)
    const ids = mpPayments.map(p => p.id);
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: rows, error } = await supabase
        .from('meli_payment_details')
        .select('payment_id')
        .in('payment_id', chunk);
      if (error) throw error;
      for (const r of rows ?? []) known.add(r.payment_id);
    }

    const unmatched = mpPayments.filter(p => !known.has(p.id));
    const unmatchedAmount = unmatched.reduce((s, p) => s + (p.amount ?? 0), 0);
    const payments = mpPayments.map(p => ({ ...p, matched: known.has(p.id) }));

    // Clasificación: el solo hecho de no estar en meli_payment_details no dice
    // POR QUÉ falta. external_reference (lo manda MercadoPago) suele llevar el
    // order_id o pack_id de MELI — cruzarlo contra nuestras propias órdenes
    // separa "no sabíamos que existía" de "ya la tenemos, falta sincronizar".
    const refs = [...new Set(unmatched.map(p => p.external_reference).filter(Boolean) as string[])];
    const orderByRef = new Map<string, { order_id: string; has_exact_data: boolean }>();
    for (let i = 0; i < refs.length; i += 100) {
      const batch = refs.slice(i, i + 100);
      const orFilter = batch.flatMap(r => [`order_id.eq.${r}`, `raw_data->>pack_id.eq.${r}`]).join(',');
      const { data: matchedOrders, error: ordersError } = await supabase
        .from('orders')
        .select('order_id, has_exact_data, raw_data')
        .eq('channel', 'meli')
        .eq('channel_account_id', meliAccount.id)
        .or(orFilter);
      if (ordersError) throw ordersError;
      for (const o of matchedOrders ?? []) {
        const entry = { order_id: o.order_id, has_exact_data: !!o.has_exact_data };
        orderByRef.set(String(o.order_id), entry);
        const packId = (o.raw_data as any)?.pack_id;
        if (packId) orderByRef.set(String(packId), entry);
      }
    }

    const classify = (p: { external_reference: string | null }) => {
      if (!p.external_reference) {
        return { reason: 'sin_referencia', label: 'MercadoPago no mandó external_reference — no se puede clasificar automáticamente' };
      }
      const match = orderByRef.get(p.external_reference);
      if (!match) {
        return { reason: 'sin_orden', label: 'No corresponde a ninguna orden tuya sincronizada — revisar si es venta de MeLi' };
      }
      if (match.has_exact_data) {
        return { reason: 'orden_cerrada', label: `Orden ${match.order_id} ya está marcada con pago confirmado — este pago llegó aparte y no se vuelve a revisar solo` };
      }
      return { reason: 'falta_sync', label: `Orden ${match.order_id} existe en tu BD — falta correr "Sync pagos" para traerlo` };
    };
    const unmatchedClassified = unmatched.map(p => ({ ...p, ...classify(p) }));

    return new Response(
      JSON.stringify({
        success: true,
        totalChecked: mpPayments.length,
        unmatchedCount: unmatched.length,
        unmatchedAmount,
        unmatched: unmatchedClassified.slice(0, 100),
        payments: payments.slice(0, 500),
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
