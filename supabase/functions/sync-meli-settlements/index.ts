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

    console.log('=== SYNC MELI SETTLEMENTS START ===');
    console.log('User ID:', user.id);

    // Get user's MercadoLibre account
    const { data: meliAccount, error: accountError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (accountError || !meliAccount) {
      console.error('Account Error:', accountError);
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch paid orders from DB (already synced via sync-meli-orders)
    const daysBack = 90;
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - daysBack);

    console.log('Fetching paid orders from database...');
    
    const { data: paidOrders, error: ordersError } = await supabaseClient
      .from('orders')
      .select('*')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('status', 'confirmed')
      .gte('order_date', dateFrom.toISOString())
      .order('order_date', { ascending: false });

    if (ordersError) {
      console.error('Error fetching orders:', ordersError);
      throw new Error('Failed to fetch orders from database');
    }

    console.log(`Found ${paidOrders?.length || 0} paid orders`);

    if (!paidOrders || paidOrders.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No hay órdenes pagadas para procesar',
          settlements: 0,
          items: 0,
          payments: 0,
          payment_sales: 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============================================
    // CAMBIO 1: Agrupar por money_release_date (YYYY-MM-DD)
    // Si no existe, usar order_date
    // Un payment = un día lógico de liberación
    // REGLA: Si money_release_date > hoy + 30 días, NO crear payment
    // ============================================
    const paymentMap = new Map<string, any>();
    const retainedOrders: any[] = [];
    
    // Calcular fecha límite: hoy + 30 días
    const today = new Date();
    const maxReleaseDate = new Date(today);
    maxReleaseDate.setDate(maxReleaseDate.getDate() + 30);
    
    console.log(`Fecha límite para pagos: ${maxReleaseDate.toISOString().split('T')[0]}`);
    
    for (const order of paidOrders) {
      // Use money_release_date if available, otherwise order_date
      const releaseDate = order.money_release_date 
        ? new Date(order.money_release_date) 
        : new Date(order.order_date);
      
      // Si la fecha de liberación es muy futura (+30 días), NO crear payment
      if (releaseDate > maxReleaseDate) {
        console.log(`⏳ Orden ${order.order_id} retenida - liberación estimada: ${releaseDate.toISOString().split('T')[0]}`);
        retainedOrders.push(order);
        continue; // Skip this order, don't include in payments
      }
      
      const releaseDateKey = releaseDate.toISOString().split('T')[0]; // YYYY-MM-DD
      
      if (!paymentMap.has(releaseDateKey)) {
        paymentMap.set(releaseDateKey, {
          release_date: releaseDateKey,
          orders: [],
        });
      }
      
      paymentMap.get(releaseDateKey).orders.push(order);
    }
    
    console.log(`${retainedOrders.length} órdenes retenidas (liberación > 30 días)`)

    console.log(`Grouped into ${paymentMap.size} release date batches`);

    let settlementsCreated = 0;
    let itemsCreated = 0;
    let paymentsCreated = 0;
    let paymentSalesCreated = 0;

    // Process each release date batch
    for (const [releaseDateKey, batchData] of paymentMap.entries()) {
      console.log(`\n=== Processing release date ${releaseDateKey} (${batchData.orders.length} orders) ===`);
      
      // Calculate totals from orders
      let grossAmount = 0;
      let feesTotal = 0;
      let netAmount = 0;
      
      const settlementItems = [];
      
      for (const order of batchData.orders) {
        const itemGross = order.gross_amount || order.amount || 0;
        const itemFees = order.commission_amount || 0;
        const itemNet = order.net_amount || (itemGross - itemFees);
        
        grossAmount += itemGross;
        feesTotal += itemFees;
        netAmount += itemNet;
        
        // ============================================
        // CAMBIO 2: payment_id = null, usar meli_order_id
        // ============================================
        settlementItems.push({
          item_type: 'SALE',
          channel: 'meli',
          payment_id: null, // No usar order_id aquí
          meli_order_id: order.order_id, // External reference
          order_id: order.id, // Internal UUID reference
          gross_amount: itemGross,
          fees_amount: itemFees,
          taxes_withheld: 0,
          net_amount: itemNet,
          shipping_cost: order.shipping_cost || 0,
          released_at: order.money_release_date || order.order_date,
          raw_data: { 
            external_order_id: order.order_id,
            source: 'orders_table' 
          },
        });
      }
      
      // Calculate period for settlement (first and last day of month containing release_date)
      const releaseDate = new Date(releaseDateKey);
      const periodStart = new Date(releaseDate.getFullYear(), releaseDate.getMonth(), 1);
      const periodEnd = new Date(releaseDate.getFullYear(), releaseDate.getMonth() + 1, 0);
      
      // Upsert settlement (grouped by month for accounting purposes)
      const { data: settlement, error: settlementError } = await supabaseClient
        .from('settlements')
        .upsert({
          channel: 'meli',
          channel_account_id: meliAccount.id,
          user_id: user.id,
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          order_count: settlementItems.length,
          gross_amount: grossAmount,
          fees_total: feesTotal,
          tax_total: 0,
          net_amount: netAmount,
          settlement_amount: netAmount,
          status: 'imported',
        }, {
          onConflict: 'channel,channel_account_id,period_start,period_end',
          ignoreDuplicates: false,
        })
        .select()
        .single();
      
      if (settlementError) {
        console.error('Error upserting settlement:', settlementError);
        continue;
      }
      
      console.log(`✅ Settlement created/updated: ${settlement.id}`);
      settlementsCreated++;
      
      // Insert settlement items (using meli_order_id as unique key since payment_id is null)
      for (const item of settlementItems) {
        const { error: itemError } = await supabaseClient
          .from('settlement_items')
          .upsert({
            ...item,
            settlement_id: settlement.id,
          }, {
            onConflict: 'settlement_id,meli_order_id',
            ignoreDuplicates: false,
          });
        
        if (itemError) {
          // Try insert if upsert fails (constraint might not exist)
          const { error: insertError } = await supabaseClient
            .from('settlement_items')
            .insert({
              ...item,
              settlement_id: settlement.id,
            });
          
          if (!insertError) {
            itemsCreated++;
          }
        } else {
          itemsCreated++;
        }
      }
      console.log(`✅ ${itemsCreated} items processed`);

      // ============================================
      // Poblar tabla payments (Ledger)
      // Un payment por día de liberación
      // ============================================
      const externalPaymentId = `MELI_${meliAccount.seller_id}_${releaseDateKey}`;
      
      // ============================================
      // CAMBIO 3: Agregar metadata de ledger
      // ============================================
      const { data: payment, error: paymentError } = await supabaseClient
        .from('payments')
        .upsert({
          user_id: user.id,
          payment_provider: 'MERCADOPAGO',
          external_payment_id: externalPaymentId,
          payment_date: releaseDateKey,
          amount: netAmount,
          gross_amount: grossAmount,
          net_amount: netAmount,
          fees_amount: feesTotal,
          status: 'ALLOCATED',
          reference: `Liberación MELI ${releaseDateKey}`,
          raw_data: {
            settlement_id: settlement.id,
            release_date: releaseDateKey,
            order_count: settlementItems.length,
            source: 'sync-meli-settlements',
            // Metadata de ledger
            ledger_type: 'LOGICAL_BATCH',
            grouping_strategy: 'ORDERS_BY_RELEASE_DATE'
          }
        }, {
          onConflict: 'external_payment_id',
          ignoreDuplicates: false,
        })
        .select()
        .single();
      
      if (paymentError) {
        console.error('Error upserting payment:', paymentError);
      } else {
        paymentsCreated++;
        console.log(`✅ Payment created/updated: ${payment.id}`);
        
        // Poblar tabla puente payment_sales
        for (const item of settlementItems) {
          if (item.order_id) {
            const { data: existingLink } = await supabaseClient
              .from('payment_sales')
              .select('id')
              .eq('payment_id', payment.id)
              .eq('sale_id', item.order_id)
              .maybeSingle();
            
            if (!existingLink) {
              const { error: linkError } = await supabaseClient
                .from('payment_sales')
                .insert({
                  payment_id: payment.id,
                  sale_id: item.order_id,
                  allocated_amount: item.net_amount,
                });
              
              if (!linkError) {
                paymentSalesCreated++;
              }
            }
          }
        }
        console.log(`✅ Payment-Sales links created for ${releaseDateKey}`);
      }
    }

    console.log('\n=== SYNC SUMMARY ===');
    console.log(`Settlements processed: ${settlementsCreated}`);
    console.log(`Items created: ${itemsCreated}`);
    console.log(`Payments created/updated: ${paymentsCreated}`);
    console.log(`Payment-Sales links created: ${paymentSalesCreated}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Sincronización de liquidaciones completada',
        settlements: settlementsCreated,
        items: itemsCreated,
        payments: paymentsCreated,
        payment_sales: paymentSalesCreated,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing settlements:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
