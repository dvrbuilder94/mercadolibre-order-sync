import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mapMeliOrderStatus } from '../_shared/order-status.ts';
import { getFreshAccessToken } from '../_shared/meli-account.ts';
import { HttpInputError, readJsonBody } from '../_shared/http.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: corsHeaders });

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const notification = await readJsonBody<{
      topic?: unknown;
      resource?: unknown;
      user_id?: unknown;
    }>(req);

    if (notification.topic !== 'orders_v2') {
      return new Response(
        JSON.stringify({ message: 'Notification ignored - not an order notification' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const resource = typeof notification.resource === 'string' ? notification.resource : '';
    const orderId = resource.match(/^\/orders\/(\d{1,30})$/)?.[1];
    const sellerId = typeof notification.user_id === 'number' || typeof notification.user_id === 'string'
      ? String(notification.user_id)
      : '';

    if (!orderId || !/^\d{1,30}$/.test(sellerId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid notification data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('seller_id', sellerId)
      .single();

    if (accountError || !meliAccount) {
      console.error('No account found for seller:', sellerId);
      return new Response(
        JSON.stringify({ message: 'Acknowledged' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let accessToken: string;
    try {
      accessToken = await getFreshAccessToken(supabaseClient, meliAccount);
    } catch (e: any) {
      console.error('Failed to refresh token:', e?.message);
      return new Response(
        JSON.stringify({ message: 'Acknowledged - token pending refresh' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderResponse = await fetch(
      `https://api.mercadolibre.com/orders/${orderId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!orderResponse.ok) {
      console.error('Failed to fetch order details:', orderResponse.status);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch order' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const order = await orderResponse.json();

    // Composite commercial identity: one external order id is unique only
    // inside the connected channel account. This must match sync-meli-orders.
    const { data: existing, error: existingError } = await supabaseClient
      .from('orders')
      .select('id, has_exact_data')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('order_id', order.id.toString())
      .maybeSingle();

    if (existingError) {
      console.error('Error checking existing order:', existingError);
      return new Response(
        JSON.stringify({ error: 'Failed to inspect existing order' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const shipping = order.shipping || {};
    const coupon = order.coupon || {};
    const firstItem = order.order_items?.[0];

    const row: Record<string, unknown> = {
      channel: 'meli',
      channel_account_id: meliAccount.id,
      meli_account_id: meliAccount.id,
      order_id: order.id.toString(),
      customer_name: order.buyer?.nickname || 'Cliente',
      customer_email: order.buyer?.email || null,
      status: mapMeliOrderStatus(order),
      order_date: order.date_created,
      amount: order.total_amount || 0,
      // Direct commercial total from MELI; never an estimate.
      gross_amount: order.total_amount || 0,
      items: order.order_items?.length || 1,
      raw_data: order,
      shipping_cost: shipping.cost || 0,
      discount_amount: coupon.amount || 0,
      currency_id: order.currency_id || 'CLP',
      shipping_mode: shipping.shipping_mode || null,
      shipping_id: shipping.id?.toString() || null,
      date_shipped: shipping.date_shipped || null,
      date_delivered: shipping.date_delivered || null,
      seller_sku: firstItem?.item?.seller_custom_field || null,
      product_title: firstItem?.item?.title || null,
    };

    // New/non-exact rows must remain eligible for MP enrichment. If the order
    // already has exact MP values, omit the flag so a webhook cannot undo them.
    if (!existing?.has_exact_data) row.has_exact_data = false;

    const { error: upsertError } = await supabaseClient
      .from('orders')
      .upsert(row, {
        onConflict: 'channel_account_id,order_id',
      });

    if (upsertError) {
      console.error('Error upserting order:', upsertError);
      return new Response(
        JSON.stringify({ error: 'Failed to save order' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Commercial order updated successfully:', orderId);
    return new Response(
      JSON.stringify({ success: true, order_id: orderId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error processing webhook:', error);
    const status = error instanceof HttpInputError ? error.status : 500;
    return new Response(
      JSON.stringify({ error: error instanceof HttpInputError ? error.message : 'Internal server error' }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
