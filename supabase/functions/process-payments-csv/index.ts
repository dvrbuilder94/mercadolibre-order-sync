import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PaymentRow {
  date: string;
  amount: number;
  reference?: string;
  bank?: string;
}

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

    const { csvData } = await req.json();
    
    if (!csvData || !Array.isArray(csvData)) {
      return new Response(JSON.stringify({ error: 'Invalid CSV data' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${csvData.length} payments for user ${user.id}`);

    const paymentsToInsert = csvData.map((row: PaymentRow) => ({
      user_id: user.id,
      payment_date: new Date(row.date).toISOString(),
      amount: row.amount,
      reference: row.reference || null,
      bank: row.bank || null,
      raw_data: row,
    }));

    const { data: payments, error: insertError } = await supabase
      .from('payments')
      .insert(paymentsToInsert)
      .select();

    if (insertError) {
      console.error('Error inserting payments:', insertError);
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Successfully inserted ${payments.length} payments`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        paymentsCreated: payments.length,
        payments 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error processing payments:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});