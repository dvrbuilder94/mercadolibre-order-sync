import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getMeliAccount } from '../_shared/meli-account.ts';
import { resolveUserId } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Split RUT into body + DV. Body = digits only, DV = last char (0-9 or K).
const splitRut = (rut: string | null | undefined): { body: string; dv: string } => {
  if (!rut) return { body: '', dv: '' };
  const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 7) return { body: '', dv: '' };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
};

// Capitalize name properly
const capitalizeName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

    const { date_from, date_to, account_id: accountIdParam, user_id: userIdParam } = await req.json().catch(() => ({}));

    const userId = await resolveUserId(req, supabaseClient, userIdParam);

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const user = { id: userId };

    // Get user's Mercado Libre account
    const { data: meliAccount, error: accountError } = await getMeliAccount(supabaseClient, user.id, {
      accountId: accountIdParam,
    });

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!meliAccount.access_token) {
      return new Response(
        JSON.stringify({ error: 'Account not authenticated. Please reconnect MercadoLibre.' }),
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
          .eq('id', meliAccount.id);
        
        console.log('Token refreshed successfully');
      } else {
        const errorText = await refreshResponse.text();
        console.error('Token refresh failed:', errorText);
        return new Response(
          JSON.stringify({ error: 'Token refresh failed. Please reconnect MercadoLibre.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Get orders without customer_tax_id that need enrichment
    let ordersQuery = supabaseClient
      .from('orders')
      .select('id, order_id, customer_name')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .is('customer_tax_id', null);

    // Without an explicit date_from/date_to, this defaults to the 150 most
    // recent orders regardless of what period the UI has open — scope it to
    // the requested period when given.
    if (date_from && date_to) {
      ordersQuery = ordersQuery.gte('order_date', date_from).lte('order_date', date_to);
    }

    const { data: orders, error: ordersError } = await ordersQuery
      .order('order_date', { ascending: false })
      .limit(150); // Larger batch; ~100ms each → ~15s

    if (ordersError) {
      console.error('Error fetching orders:', ordersError);
      return new Response(
        JSON.stringify({ error: 'Error fetching orders' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${orders?.length || 0} orders to enrich`);

    if (!orders || orders.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'No orders need enrichment',
          enriched: 0,
          failed: 0,
          remaining: 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let enrichedCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const errors: string[] = [];

    for (const order of orders) {
      processedCount++;
      try {
        // Fetch billing_info from MercadoLibre
        const billingUrl = `https://api.mercadolibre.com/orders/${order.order_id}/billing_info`;
        console.log(`Fetching billing info for order ${order.order_id}...`);

        const billingResponse = await fetch(billingUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        if (!billingResponse.ok) {
          const errorText = await billingResponse.text();
          console.error(`Error fetching billing for ${order.order_id}:`, billingResponse.status, errorText);
          failedCount++;
          errors.push(`Order ${order.order_id}: HTTP ${billingResponse.status}`);
          continue;
        }

        const billingData = await billingResponse.json();
        
        // Log raw response for debugging (first 5 orders)
        console.log(`[${processedCount}] Raw billing for ${order.order_id}:`, JSON.stringify(billingData).slice(0, 1000));
        
        // Try different paths where billing_info might be located
        const buyerBilling = billingData?.buyer?.billing_info || billingData?.billing_info;

        if (!buyerBilling) {
          console.log(`No billing_info for order ${order.order_id}, keys: ${Object.keys(billingData || {}).join(', ')}`);
          failedCount++;
          errors.push(`Order ${order.order_id}: No billing_info available`);
          continue;
        }

        // Extract RUT - handle both formats:
        // Format 1 (old): buyer.billing_info.identification.number
        // Format 2 (new): billing_info.doc_number or billing_info.additional_info
        let rawRut = buyerBilling.identification?.number || buyerBilling.doc_number;
        
        // Extract name - handle both formats
        let firstName = buyerBilling.name || '';
        let lastName = buyerBilling.last_name || '';
        
        // Check additional_info array for new format
        if (buyerBilling.additional_info && Array.isArray(buyerBilling.additional_info)) {
          const additionalInfo = buyerBilling.additional_info;
          
          const firstNameInfo = additionalInfo.find((info: { type: string; value: string }) => info.type === 'FIRST_NAME');
          const lastNameInfo = additionalInfo.find((info: { type: string; value: string }) => info.type === 'LAST_NAME');
          const docNumberInfo = additionalInfo.find((info: { type: string; value: string }) => info.type === 'DOC_NUMBER');
          
          if (firstNameInfo?.value) firstName = firstNameInfo.value;
          if (lastNameInfo?.value) lastName = lastNameInfo.value;
          if (docNumberInfo?.value && !rawRut) rawRut = docNumberInfo.value;
        }
        
        const { body: rutBody, dv: rutDv } = splitRut(rawRut);
        
        console.log(`[${processedCount}] Parsed: name=${firstName} ${lastName}, rut=${rutBody}-${rutDv}`);
        
        // Build real name
        const fullName = capitalizeName(`${firstName} ${lastName}`.trim());

        if (!rutBody && !fullName) {
          console.log(`No useful data for order ${order.order_id}`);
          failedCount++;
          errors.push(`Order ${order.order_id}: No RUT or name available`);
          continue;
        }

        // Update order with enriched data
        const updateData: Record<string, string> = {};
        if (rutBody) {
          updateData.customer_tax_id = rutBody;
          updateData.customer_tax_id_dv = rutDv;
        }
        if (fullName && fullName !== order.customer_name) {
          // Store real name, keeping nickname as backup reference
          updateData.customer_name = fullName;
        }

        if (Object.keys(updateData).length > 0) {
          const { error: updateError } = await supabaseClient
            .from('orders')
            .update(updateData)
            .eq('id', order.id);

          if (updateError) {
            console.error(`Error updating order ${order.order_id}:`, updateError);
            failedCount++;
            errors.push(`Order ${order.order_id}: Update failed`);
          } else {
            console.log(`✅ Enriched order ${order.order_id}: RUT=${rutBody}, Name=${fullName}`);
            enrichedCount++;
          }
        } else {
          console.log(`No updates needed for order ${order.order_id}`);
          failedCount++;
        }

        // Rate limiting: 80ms delay between requests
        await new Promise(resolve => setTimeout(resolve, 80));

      } catch (error) {
        console.error(`Error processing order ${order.order_id}:`, error);
        failedCount++;
        errors.push(`Order ${order.order_id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Count remaining orders that still need enrichment
    let remainingQuery = supabaseClient
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .is('customer_tax_id', null);

    if (date_from && date_to) {
      remainingQuery = remainingQuery.gte('order_date', date_from).lte('order_date', date_to);
    }

    const { count: remainingCount } = await remainingQuery;

    console.log(`\n=== ENRICHMENT SUMMARY ===`);
    console.log(`Enriched: ${enrichedCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Remaining: ${remainingCount || 0}`);

    // Self-chain: if there's more to enrich, invoke ourselves (fire-and-forget)
    if ((remainingCount || 0) > 0 && enrichedCount > 0) {
      console.log(`Chaining: ${remainingCount} orders remain, invoking enrich-meli-billing again`);
      try {
        supabaseClient.functions.invoke('enrich-meli-billing', {
          body: { date_from, date_to, account_id: meliAccount.id, user_id: userId },
        }).catch((e) =>
          console.error('Chain invoke failed:', e)
        );
      } catch (e) {
        console.error('Chain invoke threw:', e);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Enrichment completed',
        enriched: enrichedCount,
        failed: failedCount,
        remaining: remainingCount || 0,
        errors: errors.slice(0, 10), // Return first 10 errors for debugging
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error in enrich-meli-billing:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

