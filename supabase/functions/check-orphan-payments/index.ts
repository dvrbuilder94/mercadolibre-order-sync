import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

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

    const { date_from, date_to } = await req.json().catch(() => ({}));
    if (!date_from || !date_to) {
      return new Response(
        JSON.stringify({ success: false, error: 'date_from y date_to son requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await supabase
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ success: false, error: 'No se encontró cuenta de MercadoLibre conectada' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let accessToken = meliAccount.access_token;
    if (new Date(meliAccount.expires_at) <= new Date()) {
      const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: meliAccount.client_id,
          client_secret: meliAccount.client_secret,
          refresh_token: meliAccount.refresh_token,
        }),
      });
      if (!refreshResponse.ok) throw new Error('Failed to refresh token');
      const refreshData = await refreshResponse.json();
      accessToken = refreshData.access_token;
      await supabase.from('meli_accounts').update({
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token,
        expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
      }).eq('id', meliAccount.id);
    }

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

    return new Response(
      JSON.stringify({
        success: true,
        totalChecked: mpPayments.length,
        unmatchedCount: unmatched.length,
        unmatchedAmount,
        unmatched: unmatched.slice(0, 100),
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
