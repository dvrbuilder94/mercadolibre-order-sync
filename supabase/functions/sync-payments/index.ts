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
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('=== SYNC PAYMENTS START ===');
    console.log('User ID:', user.id);

    // Get user's MercadoLibre account
    const { data: meliAccount, error: accountError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (accountError) {
      console.error('Account Error:', accountError);
      throw new Error('Error fetching account');
    }

    if (!meliAccount) {
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

    // Check if token is expired and refresh if needed
    let accessToken = meliAccount.access_token;
    if (meliAccount.expires_at && new Date(meliAccount.expires_at) < new Date()) {
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
        console.log('Token refreshed successfully');
      } else {
        throw new Error('Failed to refresh token');
      }
    }

    const sellerId = meliAccount.seller_id;
    console.log('Fetching payments for seller:', sellerId);

    // Use the correct Mercado Pago Payments Search API
    // Fetch approved payments from the last 90 days
    const daysBack = 90;
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - daysBack);
    
    const paymentsUrl = `https://api.mercadopago.com/v1/payments/search?seller_id=${sellerId}&status=approved&begin_date=${dateFrom.toISOString()}&limit=100&sort=date_created&criteria=desc`;
    
    console.log('Fetching from:', paymentsUrl);
    
    const paymentsResponse = await fetch(paymentsUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!paymentsResponse.ok) {
      const errorText = await paymentsResponse.text();
      console.error('Error fetching payments:', paymentsResponse.status, errorText);
      
      // If payments search fails, try fetching from orders instead
      console.log('Falling back to orders API...');
      return await syncFromOrders(supabaseClient, user.id, accessToken, sellerId, corsHeaders);
    }

    const paymentsData = await paymentsResponse.json();
    const payments = paymentsData.results || [];
    console.log(`Found ${payments.length} payments`);

    let paymentsCreated = 0;
    let salesLinked = 0;

    // Process each payment
    for (const payment of payments) {
      const externalPaymentId = payment.id?.toString();
      if (!externalPaymentId) continue;

      const paymentDate = payment.money_release_date || payment.date_approved || payment.date_created;
      const grossAmount = payment.transaction_amount || 0;
      const netAmount = payment.transaction_details?.net_received_amount || grossAmount;
      const feesAmount = grossAmount - netAmount;

      // Upsert payment
      const { data: paymentRecord, error: paymentError } = await supabaseClient
        .from('payments')
        .upsert({
          user_id: user.id,
          payment_provider: 'MERCADOPAGO',
          external_payment_id: externalPaymentId,
          payment_date: paymentDate,
          gross_amount: grossAmount,
          fees_amount: feesAmount,
          net_amount: netAmount,
          status: 'UNALLOCATED',
          raw_data: payment,
        }, {
          onConflict: 'payment_provider,external_payment_id',
        })
        .select()
        .single();

      if (paymentError) {
        console.error('Error upserting payment:', paymentError);
        continue;
      }

      paymentsCreated++;

      // Try to link to sale using order_id or external_reference
      const orderId = payment.order?.id?.toString() || payment.external_reference;
      if (orderId) {
        const { data: sale } = await supabaseClient
          .from('orders')
          .select('id, gross_amount')
          .or(`external_sale_id.eq.${orderId},order_id.eq.${orderId}`)
          .maybeSingle();

        if (sale) {
          // Create payment_sales link
          const { error: linkError } = await supabaseClient
            .from('payment_sales')
            .upsert({
              payment_id: paymentRecord.id,
              sale_id: sale.id,
              allocated_amount: netAmount,
            }, {
              onConflict: 'payment_id,sale_id',
            });

          if (!linkError) {
            salesLinked++;

            // Update payment status to ALLOCATED
            await supabaseClient
              .from('payments')
              .update({ status: 'ALLOCATED' })
              .eq('id', paymentRecord.id);

            // Update sale status to PAID
            await supabaseClient
              .from('orders')
              .update({ sale_status: 'PAID' })
              .eq('id', sale.id);
          }
        }
      }
    }

    console.log('=== SYNC SUMMARY ===');
    console.log(`Payments created/updated: ${paymentsCreated}`);
    console.log(`Sales linked: ${salesLinked}`);

    return new Response(
      JSON.stringify({
        success: true,
        count: paymentsCreated,
        linked: salesLinked,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing payments:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Fallback: Sync payments from orders (get payment info from order payments)
async function syncFromOrders(
  supabaseClient: any, 
  userId: string, 
  accessToken: string, 
  sellerId: string,
  corsHeaders: Record<string, string>
) {
  console.log('=== SYNCING FROM ORDERS ===');
  
  // Fetch recent orders from MELI
  const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&sort=date_desc&limit=50`;
  
  const ordersResponse = await fetch(ordersUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!ordersResponse.ok) {
    const errorText = await ordersResponse.text();
    console.error('Error fetching orders:', ordersResponse.status, errorText);
    throw new Error(`Failed to fetch orders: ${ordersResponse.status}`);
  }

  const ordersData = await ordersResponse.json();
  const orders = ordersData.results || [];
  console.log(`Found ${orders.length} paid orders`);

  let paymentsCreated = 0;
  let salesLinked = 0;

  for (const order of orders) {
    // Each order can have multiple payments
    const orderPayments = order.payments || [];
    
    for (const payment of orderPayments) {
      if (payment.status !== 'approved') continue;
      
      const externalPaymentId = payment.id?.toString();
      if (!externalPaymentId) continue;

      const paymentDate = payment.date_approved || order.date_closed;
      const grossAmount = payment.transaction_amount || 0;
      const netAmount = payment.transaction_details?.net_received_amount || grossAmount;
      const feesAmount = grossAmount - netAmount;

      // Upsert payment
      const { data: paymentRecord, error: paymentError } = await supabaseClient
        .from('payments')
        .upsert({
          user_id: userId,
          payment_provider: 'MERCADOPAGO',
          external_payment_id: externalPaymentId,
          payment_date: paymentDate,
          gross_amount: grossAmount,
          fees_amount: feesAmount,
          net_amount: netAmount,
          status: 'UNALLOCATED',
          raw_data: payment,
        }, {
          onConflict: 'payment_provider,external_payment_id',
        })
        .select()
        .single();

      if (paymentError) {
        console.error('Error upserting payment:', paymentError);
        continue;
      }

      paymentsCreated++;

      // Link to order/sale
      const meliOrderId = order.id?.toString();
      if (meliOrderId) {
        const { data: sale } = await supabaseClient
          .from('orders')
          .select('id')
          .or(`external_sale_id.eq.${meliOrderId},order_id.eq.${meliOrderId}`)
          .maybeSingle();

        if (sale) {
          const { error: linkError } = await supabaseClient
            .from('payment_sales')
            .upsert({
              payment_id: paymentRecord.id,
              sale_id: sale.id,
              allocated_amount: netAmount,
            }, {
              onConflict: 'payment_id,sale_id',
            });

          if (!linkError) {
            salesLinked++;
            
            await supabaseClient
              .from('payments')
              .update({ status: 'ALLOCATED' })
              .eq('id', paymentRecord.id);

            await supabaseClient
              .from('orders')
              .update({ sale_status: 'PAID' })
              .eq('id', sale.id);
          }
        }
      }
    }
  }

  console.log('=== FALLBACK SYNC SUMMARY ===');
  console.log(`Payments: ${paymentsCreated}, Linked: ${salesLinked}`);

  return new Response(
    JSON.stringify({
      success: true,
      count: paymentsCreated,
      linked: salesLinked,
      source: 'orders',
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}
