import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Split RUT into body + DV. Body = digits only, DV = last char (0-9 or K).
function splitRut(rut: string | null | undefined): { body: string | null; dv: string | null } {
  if (!rut) return { body: null, dv: null };
  const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 7) return { body: null, dv: null };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  console.log('=== BACKFILL RUT FROM raw_data ===');

  // Fetch all ML orders that have no customer_tax_id but have raw_data
  let offset = 0;
  const pageSize = 500;
  let updated = 0;
  let alreadyHad = 0;
  let noRutInRaw = 0;
  let total = 0;

  const rutSamples: any[] = []; // for diagnostic

  while (true) {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_id, customer_tax_id, raw_data')
      .eq('channel', 'meli')
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('Fetch error:', error.message);
      break;
    }
    if (!orders || orders.length === 0) break;
    total += orders.length;

    for (const order of orders) {
      const raw = order.raw_data as any;
      const buyer = raw?.buyer || {};
      const billingInfo = buyer.billing_info || {};

      // Try multiple field paths ML might use
      const rawRut =
        billingInfo.doc_number ||
        billingInfo.docNumber ||
        billingInfo.identification_number ||
        buyer.identification?.number ||
        null;

      const { body: rutBody, dv: rutDv } = splitRut(rawRut);

      // Collect samples for diagnosis (first 20)
      if (rutSamples.length < 20) {
        rutSamples.push({
          order_id: order.order_id,
          billing_info: billingInfo,
          buyer_keys: Object.keys(buyer),
          rut_found: rutBody,
          had_rut: order.customer_tax_id,
        });
      }

      if (order.customer_tax_id && order.customer_tax_id === rutBody) {
        alreadyHad++;
        continue;
      }

      if (!rutBody) {
        noRutInRaw++;
        continue;
      }

      const { error: updateErr } = await supabaseAdmin
        .from('orders')
        .update({ customer_tax_id: rutBody, customer_tax_id_dv: rutDv })
        .eq('id', order.id);

      if (!updateErr) {
        updated++;
        console.log(`✅ Updated order ${order.order_id}: RUT ${rutBody}-${rutDv}`);
      }
    }

    if (orders.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`\nTotal orders scanned: ${total}`);
  console.log(`Updated with RUT: ${updated}`);
  console.log(`Already had RUT: ${alreadyHad}`);
  console.log(`No RUT in raw_data: ${noRutInRaw}`);

  return new Response(JSON.stringify({
    total_scanned: total,
    updated,
    already_had_rut: alreadyHad,
    no_rut_in_raw: noRutInRaw,
    samples: rutSamples, // shows exactly what fields ML is returning
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
