import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Trae reclamos/devoluciones post-venta desde la API de Post-Purchase de
// MercadoLibre (mediaciones, devoluciones, cancelaciones con reclamo, etc).
// Antes esto no se sincronizaba nunca: orders.status='returned' no lo escribe
// ningún sync, así que la app no tenía señal real de devoluciones.
//
// La API de claims no expone de forma confiable el monto reembolsado en el
// search — por eso este sync NO inventa un monto. Si la orden ya tiene un
// pago con status 'refunded'/'charged_back'/'in_mediation' en
// meli_payment_details (dato real, sincronizado por sync-meli-payment-details),
// el frontend lo muestra junto al reclamo. Si no, se deja sin monto en vez de
// estimarlo.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    let maxPagesParam = 10;
    try {
      const body = await req.json();
      maxPagesParam = body.max_pages || 10;
    } catch {
      // sin body, usar default
    }

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!meliAccount.access_token || !meliAccount.seller_id) {
      return new Response(
        JSON.stringify({ error: 'Account not authenticated' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let accessToken = meliAccount.access_token;
    if (meliAccount.expires_at && new Date(meliAccount.expires_at) < new Date()) {
      const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: meliAccount.client_id,
          client_secret: meliAccount.client_secret,
          refresh_token: meliAccount.refresh_token,
        }),
      });

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        accessToken = refreshData.access_token;
        const expiresAt = new Date(Date.now() + refreshData.expires_in * 1000);
        await supabaseClient
          .from('meli_accounts')
          .update({
            access_token: refreshData.access_token,
            refresh_token: refreshData.refresh_token,
            expires_at: expiresAt.toISOString(),
          })
          .eq('user_id', user.id);
      } else {
        throw new Error('Failed to refresh token');
      }
    }

    const sellerId = meliAccount.seller_id;
    const LIMIT = 50;
    let offset = 0;
    let totalAvailable: number | null = null;
    const claims: any[] = [];

    for (let page = 0; page < maxPagesParam; page++) {
      const url = `https://api.mercadolibre.com/post-purchase/v1/claims/search` +
        `?limit=${LIMIT}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error('Error fetching claims:', res.status, errorText);
        throw new Error(`MercadoLibre claims API error: ${res.status}`);
      }

      const body = await res.json();
      const batch = body.data || [];
      totalAvailable = body.paging?.total ?? totalAvailable;
      claims.push(...batch);

      offset += batch.length;
      if (batch.length < LIMIT || (totalAvailable != null && offset >= totalAvailable)) break;
    }

    console.log(`Found ${claims.length} claims (of ${totalAvailable ?? '?'} total)`);

    let upserted = 0;
    for (const claim of claims) {
      const claimId = claim.id?.toString();
      if (!claimId) continue;

      const resourceId: string | null = claim.resource_id?.toString() ?? null;

      // Vincular con la orden interna si ya la sincronizamos (no es obligatorio:
      // un reclamo puede existir aunque la orden todavía no se haya traído).
      let orderUuid: string | null = null;
      if (resourceId) {
        const { data: order } = await supabaseClient
          .from('orders')
          .select('id')
          .eq('channel', 'meli')
          .eq('channel_account_id', meliAccount.id)
          .eq('order_id', resourceId)
          .maybeSingle();
        orderUuid = order?.id ?? null;
      }

      const { error: upsertError } = await supabaseClient
        .from('meli_claims')
        .upsert({
          user_id: user.id,
          channel_account_id: meliAccount.id,
          claim_id: claimId,
          resource_id: resourceId,
          order_id: orderUuid,
          type: claim.type ?? null,
          stage: claim.stage ?? null,
          status: claim.status ?? null,
          reason_id: claim.reason_id ?? null,
          fulfilled: claim.fulfilled ?? null,
          date_created: claim.date_created ?? null,
          last_updated: claim.last_updated ?? null,
          raw_data: claim,
        }, { onConflict: 'channel_account_id,claim_id' });

      if (upsertError) {
        console.error('Error upserting claim:', upsertError);
        continue;
      }
      upserted++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        found: claims.length,
        upserted,
        available: totalAvailable,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing claims:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
