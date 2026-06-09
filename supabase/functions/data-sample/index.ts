import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // ── MELI ORDERS: show buyer fields ──
  const { data: orders } = await admin
    .from('orders')
    .select('order_id, customer_name, customer_email, gross_amount, order_date, raw_data')
    .order('order_date', { ascending: false })
    .limit(5);

  const meliSamples = (orders || []).map(o => {
    const raw = o.raw_data as any;
    const buyer = raw?.buyer || {};
    const billing = buyer?.billing_info || buyer?.billing || {};
    const payments = raw?.payments || [];
    const firstPayment = payments[0] || {};

    return {
      order_id: o.order_id,
      order_date: o.order_date?.slice(0, 10),
      gross_amount: o.gross_amount,
      // Buyer identity fields
      buyer_id: buyer.id,
      buyer_nickname: buyer.nickname,
      buyer_email: buyer.email,
      buyer_first_name: buyer.first_name,
      buyer_last_name: buyer.last_name,
      // Billing info — might contain RUT
      billing_doc_type: billing.doc_type,
      billing_doc_number: billing.doc_number,
      billing_full: billing,
      // Payment fields
      payment_id: firstPayment.id,
      payment_status: firstPayment.status,
      payment_method: firstPayment.payment_method_id,
      // All top-level keys in buyer object
      buyer_all_keys: Object.keys(buyer),
      // All top-level keys in billing object
      billing_all_keys: Object.keys(billing),
    };
  });

  // ── BSALE DOCS: show client fields ──
  const { data: docs } = await admin
    .from('tax_documents')
    .select('document_number, document_type, document_date, total_amount, client_name, client_tax_id, external_order_id, detected_channel, raw_data')
    .order('document_date', { ascending: false })
    .limit(5);

  const bsaleSamples = (docs || []).map(d => {
    const raw = d.raw_data as any;
    const refs = raw?.references?.items || [];

    return {
      document_number: d.document_number,
      document_type: d.document_type,
      document_date: d.document_date,
      total_amount: d.total_amount,
      // Client identity
      client_name: d.client_name,
      client_tax_id: d.client_tax_id,        // RUT as stored in our DB
      external_order_id: d.external_order_id, // ML order ID extracted from refs
      detected_channel: d.detected_channel,
      // Raw client from Bsale
      raw_client_code: raw?.clientCode || raw?.client?.code,  // code = RUT in Bsale
      raw_client_name: raw?.client?.firstName + ' ' + raw?.client?.lastName,
      raw_client_company: raw?.client?.company,
      raw_client_note: raw?.clientNote || raw?.client?.note,
      raw_client_email: raw?.client?.email,
      // References
      references: refs.map((r: any) => ({
        reason: r.reason,
        number: r.number,
        doc_type: r.document_type_id,
        date: r.date,
      })),
      payment_method_name: raw?.payment_method_name || raw?.coin?.name,
      // All keys stored in raw_data
      raw_data_keys: Object.keys(raw || {}),
    };
  });

  // ── CROSS CHECK: show if any order ID from docs matches an order ──
  const docsWithEOI = (docs || []).filter(d => d.external_order_id);
  const crossCheck = await Promise.all(
    docsWithEOI.map(async (d) => {
      const { data: match } = await admin
        .from('orders')
        .select('id, order_id, gross_amount, order_date')
        .eq('order_id', String(d.external_order_id))
        .maybeSingle();
      return {
        bsale_doc: d.document_number,
        bsale_amount: d.total_amount,
        bsale_date: d.document_date,
        external_order_id: d.external_order_id,
        order_found_in_db: !!match,
        order_amount: match?.gross_amount,
        order_date: match?.order_date?.slice(0, 10),
        amounts_match: match ? Math.abs((match.gross_amount || 0) - d.total_amount) <= 500 : false,
      };
    })
  );

  return new Response(
    JSON.stringify({ meli_orders: meliSamples, bsale_docs: bsaleSamples, cross_check: crossCheck }, null, 2),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
