import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    // Parse request body for optional date parameters
    let dateFromParam: string | null = null;
    let dateToParam: string | null = null;
    let maxPagesParam: number = 2;
    
    try {
      const body = await req.json();
      dateFromParam = body.date_from || null;
      dateToParam = body.date_to || null;
      maxPagesParam = body.max_pages || 2;
    } catch {
      // No body or invalid JSON, use defaults
    }

    const { data: { user } } = await supabaseClient.auth.getUser();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get user's Mercado Libre account (most recent one)
    const { data: meliAccount, error: accountError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    console.log('=== SYNC MELI ORDERS DEBUG ===');
    console.log('User ID:', user.id);
    console.log('MELI Account from DB:', {
      id: meliAccount?.id,
      seller_id: meliAccount?.seller_id,
      client_id: meliAccount?.client_id,
      site_id: meliAccount?.site_id,
      has_access_token: !!meliAccount?.access_token,
      expires_at: meliAccount?.expires_at,
      created_at: meliAccount?.created_at,
      updated_at: meliAccount?.updated_at,
    });

    if (accountError || !meliAccount) {
      console.error('Account Error:', accountError);
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!meliAccount.access_token || !meliAccount.seller_id) {
      return new Response(
        JSON.stringify({ error: 'Account not authenticated. Please authenticate first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if token is expired
    let accessToken = meliAccount.access_token;
    if (meliAccount.expires_at && new Date(meliAccount.expires_at) < new Date()) {
      // Token expired, refresh it
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
        
        // Update token in database
        const expiresAt = new Date(Date.now() + refreshData.expires_in * 1000);
        await supabaseClient
          .from('meli_accounts')
          .update({
            access_token: refreshData.access_token,
            refresh_token: refreshData.refresh_token,
            expires_at: expiresAt.toISOString(),
          })
          .eq('user_id', user.id);
      }
    }

    // Fetch recent orders from Mercado Libre with pagination
    const sellerId = meliAccount.seller_id;
    if (!sellerId) {
      console.error('No seller_id found for meli account');
      return new Response(
        JSON.stringify({ error: 'No seller_id configured for Mercado Libre account' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Fetching orders for seller:', sellerId);
    
    // Use date parameter if provided, otherwise default to 30 days
    let dateFrom: string;
    if (dateFromParam) {
      dateFrom = new Date(dateFromParam).toISOString();
      console.log('Using custom date_from:', dateFrom);
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      dateFrom = thirtyDaysAgo.toISOString();
    }

    const dateTo: string | null = dateToParam ? new Date(dateToParam).toISOString() : null;
    if (dateTo) console.log('Using custom date_to:', dateTo);

    // Fetch all orders with pagination
    let allOrders: any[] = [];
    let offset = 0;
    const limit = 50; // MELI API max limit
    const maxPages = Math.min(maxPagesParam, 20); // Cap at 20 pages (1000 orders) to prevent timeout
    let currentPage = 0;
    let totalAvailable = 0;

    console.log('\n=== STARTING PAGINATION ===');
    console.log(`Date from: ${dateFrom}`);
    console.log(`Max pages: ${maxPages}`);

    while (currentPage < maxPages) {
      const dateToFilter = dateTo ? `&order.date_created.to=${dateTo}` : '';
      const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc&order.date_created.from=${dateFrom}${dateToFilter}&limit=${limit}&offset=${offset}`;
      console.log(`\nPage ${currentPage + 1}: Fetching from offset ${offset}`);

      const ordersResponse = await fetch(ordersUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!ordersResponse.ok) {
        const errorText = await ordersResponse.text();
        console.error('Error fetching orders:', ordersResponse.status, errorText);
        break;
      }

      const ordersData = await ordersResponse.json();
      const orders = ordersData.results || [];
      totalAvailable = ordersData.paging?.total || 0;

      console.log(`Fetched ${orders.length} orders (Total available: ${totalAvailable})`);
      
      if (orders.length === 0) {
        console.log('No more orders to fetch');
        break;
      }

      allOrders = [...allOrders, ...orders];

      // Check if we've fetched all available orders
      if (offset + limit >= totalAvailable) {
        console.log('All orders fetched');
        break;
      }

      offset += limit;
      currentPage++;

      // Minimal delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.log(`\n=== PAGINATION COMPLETE ===`);
    console.log(`Total pages fetched: ${currentPage + 1}`);
    console.log(`Total orders collected: ${allOrders.length}`);
    console.log(`Total available in MELI: ${totalAvailable}`);

    console.log(`\n=== PROCESSING ${allOrders.length} ORDERS ===\n`);

    // Process and upsert orders
    let syncedCount = 0;
    let errorCount = 0;
    
    for (const order of allOrders) {
      try {
        const buyer = order.buyer || {};
        const orderDate = new Date(order.date_created);
        
        // Log detailed order information
        console.log(`\n--- Order ${order.id} ---`);
        console.log(`Status: ${order.status}`);
        console.log(`Total Amount: ${order.total_amount} ${order.currency_id}`);
        console.log(`Buyer: ${buyer.nickname || 'N/A'} (${buyer.email || 'no email'})`);
        console.log(`Date: ${orderDate.toISOString()}`);
        console.log(`Items count: ${order.order_items?.length || 0}`);
        
        // Log payment details
        if (order.payments && order.payments.length > 0) {
          console.log(`Payments (${order.payments.length}):`);
          order.payments.forEach((payment: any, idx: number) => {
            console.log(`  ${idx + 1}. ${payment.payment_method_id}: ${payment.transaction_amount} ${payment.currency_id} - Status: ${payment.status}`);
          });
        }
        
        // Log shipping details
        if (order.shipping) {
          console.log(`Shipping ID: ${order.shipping.id}`);
          console.log(`Shipping Status: ${order.shipping.status || 'N/A'}`);
        }
        
        // Log items
        if (order.order_items && order.order_items.length > 0) {
          console.log(`Items:`);
          order.order_items.forEach((item: any, idx: number) => {
            console.log(`  ${idx + 1}. ${item.item?.title || 'Unknown'} - Qty: ${item.quantity} - Price: ${item.unit_price} ${item.currency_id}`);
          });
        }
        
        // Map Mercado Libre status to our status
        let status = 'pending';
        if (order.status === 'paid') status = 'confirmed';
        if (order.status === 'cancelled') status = 'cancelled';
        if (order.shipping?.status === 'shipped') status = 'shipped';
        if (order.shipping?.status === 'delivered') status = 'delivered';

        // Extract payment data for commission calculation
        const payment = order.payments?.[0];
        const paymentMethod = payment?.payment_method_id || 'unknown';
        const paymentMethodType = payment?.payment_type_id || null; // credit_card, debit_card, account_money, etc.
        const paymentMethodBrand = payment?.card?.cardholder?.name ? null : (payment?.issuer_id || payment?.payment_method_id || null); // visa, master, etc.
        const paymentApprovedAt = payment?.date_approved;
        const grossAmount = order.total_amount || 0;
        const shipping = order.shipping || {};
        const coupon = order.coupon || {};

        // Calculate estimated commission based on payment method
        let commissionPercentage = 3.99; // default
        if (paymentMethod === 'account_money') commissionPercentage = 2.99;
        else if (['credit_card', 'master', 'visa'].includes(paymentMethod)) commissionPercentage = 4.99;
        else if (['debit_card', 'debvisa', 'debmaster'].includes(paymentMethod)) commissionPercentage = 3.49;

        const commissionAmount = Math.round(grossAmount * (commissionPercentage / 100) * 100) / 100;
        const netAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;

        // Calculate expected payment date (14 days after approval)
        let expectedPaymentDate = orderDate;
        let moneyReleaseDate = null;
        if (paymentApprovedAt) {
          const approvalDate = new Date(paymentApprovedAt);
          expectedPaymentDate = new Date(approvalDate.getTime() + 14 * 24 * 60 * 60 * 1000);
          moneyReleaseDate = payment?.money_release_date || expectedPaymentDate.toISOString();
        }

        // Calculate settlement amount (what actually reaches the bank)
        const shippingCost = shipping.cost || 0;
        const discountAmount = coupon.amount || 0;
        const shippingMode = shipping.shipping_mode || 'custom';
        
        // If Mercado Envíos (me2), shipping is NOT received by seller
        const shippingDeduction = shippingMode === 'me2' ? shippingCost : 0;
        const settlementAmount = Math.round((grossAmount - discountAmount - shippingDeduction - commissionAmount) * 100) / 100;
        
        // Extract product details
        const firstItem = order.order_items?.[0];
        const productTitle = firstItem?.item?.title || null;
        const sellerSku = firstItem?.item?.seller_custom_field || null;

        const orderData = {
          channel: 'meli',
          channel_account_id: meliAccount.id,
          meli_account_id: meliAccount.id, // Keep for backward compatibility
          order_id: order.id.toString(),
          customer_name: buyer.nickname || 'Cliente',
          customer_email: buyer.email || null,
          order_date: orderDate.toISOString(),
          amount: order.total_amount || 0,
          status: status,
          items: order.order_items?.length || 1,
          raw_data: order,
          
          // Financial data
          gross_amount: grossAmount,
          net_amount: netAmount,
          commission_percentage: commissionPercentage,
          commission_amount: commissionAmount,
          payment_method: paymentMethod,
          payment_approved_at: paymentApprovedAt || orderDate.toISOString(),
          expected_payment_date: expectedPaymentDate.toISOString(),
          has_exact_data: false,
          
          // FASE 1: Critical fields
          money_release_date: moneyReleaseDate,
          settlement_date: expectedPaymentDate.toISOString(),
          settlement_amount: settlementAmount,
          bank_reference: `MELI-${order.id}`,
          shipping_cost: shippingCost,
          discount_amount: discountAmount,
          currency_id: order.currency_id || 'CLP',
          shipping_mode: shippingMode,
          
          // FASE 2: Financial details
          installments: payment?.installments || 1,
          installment_amount: payment?.installment_amount || grossAmount,
          financing_fee: 0, // Will be updated with exact data
          tax_amount: 0, // Will be updated with exact data
          payment_method_type: paymentMethodType,
          payment_method_brand: paymentMethodBrand,
          
          // FASE 3: Operational details
          shipping_id: shipping.id?.toString() || null,
          date_shipped: shipping.date_shipped || null,
          date_delivered: shipping.date_delivered || null,
          seller_sku: sellerSku,
          product_title: productTitle,
        };

        console.log(`Attempting to upsert order ${order.id}...`);
        
        // Upsert order
        const { data: upsertedOrder, error: upsertError } = await supabaseClient
          .from('orders')
          .upsert(orderData, {
            onConflict: 'channel_account_id,order_id',
            ignoreDuplicates: false,
          })
          .select()
          .single();

        if (upsertError) {
          console.error(`❌ Error upserting order ${order.id}:`, upsertError);
          errorCount++;
        } else {
          console.log(`✅ Successfully synced order ${order.id}`);
          syncedCount++;

          // For orders from the last 7 days, fetch exact payment details
          const orderAge = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
          
          // DISABLED: Skip exact payment data fetch for performance
          // Users can use sync-meli-payment-details for exact data
          // This significantly speeds up the sync process
          /*
          if (orderAge <= 7 && payment?.id && upsertedOrder) {
...
              console.log(`⚠️ Could not fetch exact payment details: ${error}. Using estimates.`);
            }
          }
          */
        }
      } catch (error) {
        console.error(`❌ Error processing order ${order.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`\n=== SYNC SUMMARY ===`);
    console.log(`Total orders processed: ${allOrders.length}`);
    console.log(`Successfully synced: ${syncedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Pages fetched: ${currentPage + 1}`);
    console.log(`Total available: ${totalAvailable}`);

    return new Response(
      JSON.stringify({ 
        success: true,
        message: 'Sincronización completada',
        total: allOrders.length,
        synced: syncedCount,
        errors: errorCount,
        pages: currentPage + 1,
        available: totalAvailable,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing orders:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
