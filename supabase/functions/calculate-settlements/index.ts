import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { daysBack = 90 } = await req.json().catch(() => ({}));

    console.log(`Calculating settlements for user ${user.id}, looking back ${daysBack} days`);

    // Get orders without settlement_id from the last N days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .is('settlement_id', null)
      .gte('order_date', cutoffDate.toISOString())
      .order('order_date', { ascending: true });

    if (ordersError) {
      console.error('Error fetching orders:', ordersError);
      throw ordersError;
    }

    console.log(`Found ${orders?.length || 0} orders without settlements`);

    // Group orders by channel, account, and bi-weekly period
    const settlementGroups = new Map<string, any[]>();

    for (const order of orders || []) {
      const orderDate = new Date(order.order_date);
      const year = orderDate.getFullYear();
      const month = orderDate.getMonth();
      const day = orderDate.getDate();
      
      // Determine bi-weekly period: 1-15 or 16-end of month
      const isFirstHalf = day <= 15;
      const periodStart = new Date(year, month, isFirstHalf ? 1 : 16);
      const periodEnd = isFirstHalf 
        ? new Date(year, month, 15)
        : new Date(year, month + 1, 0); // Last day of month

      const groupKey = `${order.channel}-${order.channel_account_id}-${periodStart.toISOString().split('T')[0]}`;

      if (!settlementGroups.has(groupKey)) {
        settlementGroups.set(groupKey, []);
      }
      settlementGroups.get(groupKey)!.push(order);
    }

    console.log(`Created ${settlementGroups.size} settlement groups`);

    const createdSettlements = [];
    const updatedOrders = [];

    // Process each settlement group
    for (const [groupKey, groupOrders] of settlementGroups) {
      const firstOrder = groupOrders[0];
      const orderDate = new Date(firstOrder.order_date);
      const year = orderDate.getFullYear();
      const month = orderDate.getMonth();
      const day = orderDate.getDate();
      const isFirstHalf = day <= 15;

      const periodStart = new Date(year, month, isFirstHalf ? 1 : 16);
      const periodEnd = isFirstHalf 
        ? new Date(year, month, 15)
        : new Date(year, month + 1, 0);

      // Calculate aggregates
      const grossAmount = groupOrders.reduce((sum, o) => sum + (Number(o.gross_amount) || Number(o.amount) || 0), 0);
      const feesTotal = groupOrders.reduce((sum, o) => sum + (Number(o.commission_amount) || 0), 0);
      const taxTotal = groupOrders.reduce((sum, o) => sum + (Number(o.vat_amount) || 0), 0);
      const netAmount = groupOrders.reduce((sum, o) => sum + (Number(o.net_amount) || 0), 0);
      const settlementAmount = groupOrders.reduce((sum, o) => sum + (Number(o.settlement_amount) || Number(o.net_amount) || 0), 0);

      // Fetch user_id from account table
      let userId = user.id;
      if (firstOrder.channel === 'meli') {
        const { data: account } = await supabase
          .from('meli_accounts')
          .select('user_id')
          .eq('id', firstOrder.channel_account_id)
          .single();
        if (account) userId = account.user_id;
      }

      // Create or update settlement
      const { data: settlement, error: settlementError } = await supabase
        .from('settlements')
        .upsert({
          user_id: userId,
          channel: firstOrder.channel,
          channel_account_id: firstOrder.channel_account_id,
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          gross_amount: grossAmount,
          fees_total: feesTotal,
          tax_total: taxTotal,
          net_amount: netAmount,
          settlement_amount: settlementAmount,
          order_count: groupOrders.length,
        }, {
          onConflict: 'channel_account_id,period_start,period_end'
        })
        .select()
        .single();

      if (settlementError) {
        console.error('Error creating settlement:', settlementError);
        continue;
      }

      createdSettlements.push(settlement);

      // Update orders with settlement_id
      const orderIds = groupOrders.map(o => o.id);
      const { error: updateError } = await supabase
        .from('orders')
        .update({ settlement_id: settlement.id })
        .in('id', orderIds);

      if (updateError) {
        console.error('Error updating orders:', updateError);
      } else {
        updatedOrders.push(...orderIds);
      }
    }

    console.log(`Created/updated ${createdSettlements.length} settlements`);
    console.log(`Updated ${updatedOrders.length} orders`);

    return new Response(
      JSON.stringify({
        success: true,
        settlementsCreated: createdSettlements.length,
        ordersUpdated: updatedOrders.length,
        settlements: createdSettlements,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in calculate-settlements:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
