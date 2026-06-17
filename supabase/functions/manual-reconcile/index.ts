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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { orderId, paymentId, notes } = await req.json();

    if (!orderId || !paymentId) {
      return new Response(
        JSON.stringify({ error: 'Order ID and Payment ID are required' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`Manual reconciliation: order ${orderId} with payment ${paymentId}`);

    // Create reconciliation
    const { data: reconciliation, error: createError } = await supabase
      .from('reconciliations')
      .insert({
        order_id: orderId,
        payment_id: paymentId,
        reconciliation_type: 'manual',
        created_by: user.id,
        notes: notes || null,
      })
      .select()
      .single();

    if (createError) {
      console.error('Error creating reconciliation:', createError);
      return new Response(JSON.stringify({ error: createError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update order status
    const { error: updateError } = await supabase
      .from('orders')
      .update({ reconciliation_status: 'reconciled' })
      .eq('id', orderId);

    if (updateError) {
      console.error('Error updating order:', updateError);
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Manual reconciliation created successfully`);

    return new Response(
      JSON.stringify({ success: true, reconciliation }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in manual reconciliation:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});