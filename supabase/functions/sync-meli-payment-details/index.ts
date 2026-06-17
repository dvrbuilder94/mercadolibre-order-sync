import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

// CORS configuration - MUST be present on ALL responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // CRITICAL: Always handle OPTIONS first, before any other logic
  if (req.method === 'OPTIONS') {
    console.log('🔓 CORS preflight request received');
    return new Response('ok', { 
      status: 200,
      headers: corsHeaders 
    });
  }
  
  console.log(`🌐 ${req.method} request from ${req.headers.get('origin')}`);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.error('❌ Authentication failed:', authError);
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'No autorizado. Por favor, recarga la página e inicia sesión nuevamente.'
        }),
        { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const { date_from, date_to, days_back, limit = 50 } = await req.json().catch(() => ({}));
    const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 100));

    console.log(`🚀 Fetching exact payment details (limit: ${effectiveLimit}, date_from: ${date_from ?? '-'}, date_to: ${date_to ?? '-'}, days_back: ${days_back ?? 'sin límite — backfill completo'})`);

    // 1. Get MELI account
    const { data: meliAccount, error: accountError } = await supabase
      .from('meli_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (accountError || !meliAccount) {
      console.error('❌ No MELI account found:', accountError);
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'No se encontró cuenta de MercadoLibre conectada'
        }),
        { 
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    // 2. Check/refresh token
    let accessToken = meliAccount.access_token;
    const now = new Date();
    const expiresAt = new Date(meliAccount.expires_at);

    if (expiresAt <= now) {
      console.log('Access token expired, refreshing...');
      
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

      if (!refreshResponse.ok) {
        throw new Error('Failed to refresh token');
      }

      const refreshData = await refreshResponse.json();
      accessToken = refreshData.access_token;

      await supabase.from('meli_accounts').update({
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token,
        expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
      }).eq('id', meliAccount.id);
    }

    // 3. Get orders without exact data (most recent first; self-chains until none remain)
    let ordersQuery = supabase
      .from('orders')
      .select('id, order_id, amount, raw_data')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('has_exact_data', false)
      .order('order_date', { ascending: false })
      .limit(effectiveLimit);

    // An explicit date_from/date_to (e.g. the period the user has open in the
    // UI) takes priority over days_back, which can only express "from N days
    // ago until now" and can't target an arbitrary past month.
    if (date_from && date_to) {
      ordersQuery = ordersQuery.gte('order_date', date_from).lte('order_date', date_to);
    } else if (days_back) {
      const cutoffDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
      ordersQuery = ordersQuery.gte('order_date', cutoffDate);
    }

    const { data: orders, error: ordersError } = await ordersQuery;

    if (ordersError) throw ordersError;

    const totalOrders = orders?.length || 0;
    console.log(`📦 Found ${totalOrders} orders without exact data. Processing in batches of 10...`);

    if (totalOrders === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          updated: 0,
          skipped: 0,
          errors: 0,
          message: 'No hay órdenes pendientes de sincronizar'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Stats tracking
    let processed = 0;
    let updated = 0;
    let errors = 0;
    let skipped = 0;
    let paymentsLinked = 0;

    // 4. Process orders in batches of 10
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < (orders || []).length; i += BATCH_SIZE) {
      batches.push((orders || []).slice(i, i + BATCH_SIZE));
    }

    console.log(`📊 Processing ${totalOrders} orders in ${batches.length} batches of ${BATCH_SIZE}`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`\n🔄 Batch ${batchIndex + 1}/${batches.length} - Processing ${batch.length} orders...`);

      for (const order of batch) {
        const payments = order.raw_data?.payments || [];
        
        if (payments.length === 0) {
          console.log(`  ⚠️ Order ${order.order_id} has no payment IDs, skipping`);
          skipped++;
          processed++;
          continue;
        }

        console.log(`  📝 Processing order ${order.order_id} with ${payments.length} payment(s)`);
        
        let orderHasValidPayment = false;
        let totalNetReceived = 0;
        let totalFees = 0;
        let latestMoneyReleaseDate = null;

        // Process all payments for this order
        for (const payment of payments) {
          const paymentId = payment.id;
          
          if (!paymentId) {
            console.log(`    ⚠️ Payment without ID in order ${order.order_id}, skipping`);
            continue;
          }

          try {
            console.log(`    🔍 Fetching payment details for ${paymentId}...`);
          
            const response = await fetch(
              `https://api.mercadopago.com/v1/payments/${paymentId}`,
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );

            if (response.status === 429) {
              console.log(`    ⏱️ Rate limit hit, waiting 5 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              errors++;
              continue;
            }

            if (!response.ok) {
              console.error(`    ❌ Error fetching payment ${paymentId}: ${response.status}`);
              errors++;
              continue;
            }

            const paymentDetails = await response.json();
            
            console.log(`    📊 Payment ${paymentId} response:`, JSON.stringify({
              id: paymentDetails.id,
              transaction_amount: paymentDetails.transaction_amount,
              net_received_amount: paymentDetails.net_received_amount,
              transaction_details: paymentDetails.transaction_details,
              fee_details: paymentDetails.fee_details
            }));

            // MercadoLibre payments API returns transaction_details with net_received_amount
            const netReceived = paymentDetails.net_received_amount || 
                               paymentDetails.transaction_details?.net_received_amount ||
                               0;
            
            if (netReceived > 0 || paymentDetails.transaction_amount) {
              const transactionAmount = paymentDetails.transaction_amount || 0;
              const actualNetReceived = netReceived || (transactionAmount * 0.97); // Fallback estimate
              const paymentFees = paymentDetails.fee_details?.reduce((sum: number, f: any) => sum + (f.amount || 0), 0) || 
                                 (transactionAmount - actualNetReceived); // Calculate from difference if no fee_details
              
              // Save individual payment details
              const { error: insertError } = await supabase.from('meli_payment_details').upsert({
                order_id: order.id,
                payment_id: paymentId.toString(),
                transaction_amount: transactionAmount,
                net_received_amount: actualNetReceived,
                total_fees: paymentFees,
                marketplace_fee: paymentDetails.fee_details?.find((f: any) => f.type === 'marketplace_fee')?.amount || paymentFees,
                financing_fee: paymentDetails.fee_details?.find((f: any) => f.type === 'financing_fee')?.amount || 0,
                shipping_fee: paymentDetails.fee_details?.find((f: any) => f.type === 'shipping_fee')?.amount || 0,
                fee_details: paymentDetails.fee_details,
                payment_method: paymentDetails.payment_method_id,
                date_approved: paymentDetails.date_approved,
                money_release_date: paymentDetails.money_release_date || paymentDetails.date_approved,
                status: paymentDetails.status,
                raw_data: paymentDetails
              }, { onConflict: 'payment_id' });

              if (insertError) {
                console.error(`    ❌ Error saving payment details: ${insertError.message}`);
                errors++;
              } else {
                console.log(`    ✅ Saved payment ${paymentId} details (net: ${actualNetReceived})`);
                orderHasValidPayment = true;
                totalNetReceived += actualNetReceived;
                totalFees += paymentFees;

                // Track latest money release date
                const releaseDate = paymentDetails.money_release_date || paymentDetails.date_approved;
                if (releaseDate) {
                  if (!latestMoneyReleaseDate || new Date(releaseDate) > new Date(latestMoneyReleaseDate)) {
                    latestMoneyReleaseDate = releaseDate;
                  }
                }

                // Mirror the real MP payment into the ledger (payments + payment_sales),
                // replacing the synthetic rows that sync-meli-settlements used to fabricate.
                const { data: paymentRow, error: paymentUpsertError } = await supabase
                  .from('payments')
                  .upsert({
                    user_id: user.id,
                    payment_provider: 'MERCADOPAGO',
                    external_payment_id: paymentId.toString(),
                    payment_date: paymentDetails.date_approved || releaseDate || new Date().toISOString(),
                    gross_amount: transactionAmount,
                    net_amount: actualNetReceived,
                    fees_amount: paymentFees,
                    amount: actualNetReceived,
                    status: 'ALLOCATED',
                    reference: `MP ${paymentId} · Orden ${order.order_id}`,
                    raw_data: {
                      source: 'sync-meli-payment-details',
                      order_id: order.order_id,
                      money_release_date: releaseDate,
                      mp_status: paymentDetails.status,
                    },
                  }, { onConflict: 'external_payment_id' })
                  .select('id')
                  .single();

                if (paymentUpsertError) {
                  console.error(`    ❌ Error upserting payment ledger row: ${paymentUpsertError.message}`);
                  errors++;
                } else {
                  const { error: linkError } = await supabase
                    .from('payment_sales')
                    .upsert({
                      payment_id: paymentRow.id,
                      sale_id: order.id,
                      allocated_amount: actualNetReceived,
                    }, { onConflict: 'payment_id,sale_id' });

                  if (linkError) {
                    console.error(`    ❌ Error linking payment_sales: ${linkError.message}`);
                    errors++;
                  } else {
                    paymentsLinked++;
                  }
                }
              }
            } else {
              console.log(`    ⚠️ Payment ${paymentId} has no valid amount data, skipping`);
            }

            // Rate limit: 200ms between payment requests (respects API limits)
            await new Promise(resolve => setTimeout(resolve, 200));

          } catch (error) {
            console.error(`    ❌ Error processing payment ${paymentId}:`, error);
            errors++;
          }
        }

        // Update order with aggregated data from all payments
        if (orderHasValidPayment) {
          const commissionPercentage = order.amount > 0
            ? (totalFees / order.amount * 100).toFixed(2)
            : '0';

          // Calculate exact settlement_amount
          const shippingCost = order.raw_data?.shipping?.cost || 0;
          const shippingMode = order.raw_data?.shipping?.shipping_mode || 'custom';
          const shippingDeduction = shippingMode === 'me2' ? shippingCost : 0;
          const settlementAmount = Math.round(
            (totalNetReceived - shippingDeduction) * 100
          ) / 100;

          const { error: updateError } = await supabase.from('orders').update({
            gross_amount: order.amount,
            net_amount: totalNetReceived,
            commission_amount: totalFees,
            commission_percentage: parseFloat(commissionPercentage),
            expected_payment_date: latestMoneyReleaseDate,
            money_release_date: latestMoneyReleaseDate,
            settlement_date: latestMoneyReleaseDate,
            settlement_amount: settlementAmount,
            financing_fee: totalFees,
            tax_amount: 0,
            has_exact_data: true
          }).eq('id', order.id);

          if (updateError) {
            console.error(`    ❌ Error updating order ${order.order_id}: ${updateError.message}`);
            errors++;
          } else {
            updated++;
            console.log(`    ✨ Updated order ${order.order_id} with exact data (${payments.length} payment(s), net: ${totalNetReceived})`);
          }
        }

        processed++;
      }

      // Delay between batches (except after last batch)
      if (batchIndex < batches.length - 1) {
        console.log(`⏳ Waiting 0.5 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const successRate = processed > 0 ? ((updated / processed) * 100).toFixed(1) : '0';

    // 5. Count remaining orders and self-chain if there's more backlog to process
    let remainingQuery = supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('has_exact_data', false);

    if (date_from && date_to) {
      remainingQuery = remainingQuery.gte('order_date', date_from).lte('order_date', date_to);
    } else if (days_back) {
      const cutoffDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
      remainingQuery = remainingQuery.gte('order_date', cutoffDate);
    }

    const { count: remainingCount } = await remainingQuery;

    console.log(`\n✅ SYNC COMPLETED:
      - Total orders: ${totalOrders}
      - Processed: ${processed}
      - Updated: ${updated}
      - Payments linked to ledger: ${paymentsLinked}
      - Skipped: ${skipped} (no payments)
      - Errors: ${errors}
      - Success rate: ${successRate}%
      - Remaining without exact data: ${remainingCount ?? 0}
    `);

    if ((remainingCount || 0) > 0 && updated > 0) {
      console.log(`Chaining: ${remainingCount} orders remain, invoking sync-meli-payment-details again`);
      try {
        supabase.functions.invoke('sync-meli-payment-details', { body: { date_from, date_to, days_back, limit } }).catch((e) =>
          console.error('Chain invoke failed:', e)
        );
      } catch (e) {
        console.error('Chain invoke threw:', e);
      }
    }

    // Return final results
    return new Response(
      JSON.stringify({
        success: true,
        processed,
        updated,
        paymentsLinked,
        skipped,
        errors,
        remaining: remainingCount ?? 0,
        successRate: parseFloat(successRate),
        message: `✅ Sincronización completada: ${updated}/${totalOrders} órdenes actualizadas`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('❌ Fatal error:', error);
    console.error('Error stack:', error.stack);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message || 'Error desconocido',
        details: error.stack
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
