import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const notification = await req.json();
    console.log('Received Mercado Libre notification:', notification);

    // Mercado Libre envía notificaciones con esta estructura:
    // { topic: "orders_v2", resource: "/orders/123456789", user_id: 123456 }
    
    if (notification.topic !== 'orders_v2') {
      return new Response(
        JSON.stringify({ message: 'Notification ignored - not an order notification' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extraer el ID de la orden de la URL del resource
    const orderId = notification.resource?.split('/').pop();
    const sellerId = notification.user_id?.toString();

    if (!orderId || !sellerId) {
      console.error('Missing order ID or seller ID in notification');
      return new Response(
        JSON.stringify({ error: 'Invalid notification data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Buscar la cuenta de Mercado Libre asociada a este seller_id
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

    // Verificar si el token está expirado
    const now = new Date();
    const expiresAt = new Date(meliAccount.expires_at);
    
    let accessToken = meliAccount.access_token;

    if (now >= expiresAt) {
      console.log('Token expired, refreshing...');
      
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

      if (!refreshResponse.ok) {
        console.error('Failed to refresh token');
        return new Response(
          JSON.stringify({ error: 'Failed to refresh token' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const tokenData = await refreshResponse.json();
      accessToken = tokenData.access_token;
      const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

      await supabaseClient
        .from('meli_accounts')
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: newExpiresAt.toISOString(),
        })
        .eq('id', meliAccount.id);
    }

    // Obtener detalles de la orden actualizada
    const orderResponse = await fetch(
      `https://api.mercadolibre.com/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!orderResponse.ok) {
      console.error('Failed to fetch order details');
      return new Response(
        JSON.stringify({ error: 'Failed to fetch order' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const order = await orderResponse.json();

    // Actualizar o insertar la orden en la base de datos
    const { error: upsertError } = await supabaseClient
      .from('orders')
      .upsert({
        order_id: order.id.toString(),
        meli_account_id: meliAccount.id,
        customer_name: order.buyer?.nickname || 'Desconocido',
        customer_email: order.buyer?.email || null,
        status: order.status,
        order_date: order.date_created,
        amount: order.total_amount,
        items: order.order_items?.length || 0,
        raw_data: order,
      }, {
        onConflict: 'order_id',
      });

    if (upsertError) {
      console.error('Error upserting order:', upsertError);
      return new Response(
        JSON.stringify({ error: 'Failed to save order' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Order updated successfully:', orderId);

    return new Response(
      JSON.stringify({ success: true, order_id: orderId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error processing webhook:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
