import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BankMovement {
  date: string;
  amount: number;
  description?: string;
  account?: string;
  reference?: string;
}

function extractReference(description: string): string | null {
  if (!description) return null;
  
  // Try to extract MELI/MP reference
  const meliMatch = description.match(/MELI[- ]?(\d+)/i);
  if (meliMatch) return meliMatch[0];
  
  const mpMatch = description.match(/MERCADO\s*PAGO[^\d]*(\d+)/i);
  if (mpMatch) return mpMatch[1];
  
  // Extract any number sequence
  const numberMatch = description.match(/\d{6,}/);
  if (numberMatch) return numberMatch[0];
  
  return null;
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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    const { movements, source = 'csv' } = await req.json();

    if (!movements || !Array.isArray(movements) || movements.length === 0) {
      throw new Error('No movements provided');
    }

    console.log(`Importing ${movements.length} bank movements from ${source}`);

    const movementsToInsert = movements.map((m: BankMovement) => ({
      user_id: user.id,
      movement_date: new Date(m.date).toISOString(),
      amount: m.amount,
      description: m.description || null,
      bank_account: m.account || null,
      source_channel: source,
      external_reference: m.reference || extractReference(m.description || ''),
      raw_data: m,
    }));

    const { data, error } = await supabase
      .from('bank_movements')
      .insert(movementsToInsert)
      .select();

    if (error) {
      console.error('Error inserting movements:', error);
      throw error;
    }

    console.log(`Successfully imported ${data?.length || 0} movements`);

    return new Response(
      JSON.stringify({
        success: true,
        count: data?.length || 0,
        message: `Successfully imported ${data?.length || 0} bank movements`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});