import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const period: string = body.period ?? new Date().toISOString().slice(0, 7);
    const includeRaw: boolean = !!body.include_raw;

    const [y, m] = period.split('-').map(Number);
    const fromISO = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const toISO = new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString();
    const fromDate = `${period}-01`;
    const toDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

    const orderFields = [
      'id', 'order_id', 'order_date', 'status', 'gross_amount', 'net_amount',
      'commission_amount', 'commission_percentage', 'shipping_cost', 'discount_amount',
      'settlement_amount', 'money_release_date', 'customer_name', 'customer_tax_id',
      'customer_tax_id_dv', 'shipping_mode', 'shipping_id', 'payment_method',
      'installments', 'currency_id', 'marketplace', 'channel', 'channel_account_id',
      'external_order_id',
    ];
    const docFields = [
      'id', 'document_type', 'document_number', 'document_date', 'net_amount',
      'tax_amount', 'total_amount', 'client_name', 'client_tax_id', 'client_tax_id_dv',
      'external_system', 'external_id', 'external_order_id', 'status', 'erp',
      'sales_channel', 'detected_channel', 'original_tax_document_id',
    ];
    const paymentFields = [
      'id', 'external_payment_id', 'payment_date', 'amount', 'gross_amount',
      'net_amount', 'fees_amount', 'status', 'payment_provider', 'reference', 'bank',
    ];

    const orderSel = includeRaw ? [...orderFields, 'raw_data'].join(',') : orderFields.join(',');
    const docSel = includeRaw ? [...docFields, 'raw_data'].join(',') : docFields.join(',');
    const paymentSel = includeRaw ? [...paymentFields, 'raw_data'].join(',') : paymentFields.join(',');

    const [ordersRes, docsRes, paymentsRes] = await Promise.all([
      supabase.from('orders').select(orderSel)
        .gte('order_date', fromISO).lte('order_date', toISO)
        .order('order_date', { ascending: true }),
      supabase.from('tax_documents').select(docSel)
        .gte('document_date', fromDate).lte('document_date', toDate)
        .order('document_date', { ascending: true }),
      supabase.from('payments').select(paymentSel)
        .gte('payment_date', fromISO).lte('payment_date', toISO)
        .order('payment_date', { ascending: true }),
    ]);

    if (ordersRes.error) throw ordersRes.error;
    if (docsRes.error) throw docsRes.error;
    if (paymentsRes.error) throw paymentsRes.error;

    const orders = ordersRes.data ?? [];
    const docs = docsRes.data ?? [];
    const payments = paymentsRes.data ?? [];

    const orderIds = orders.map((o: any) => o.id);
    const docIds = docs.map((d: any) => d.id);
    const paymentIds = payments.map((p: any) => p.id);

    const [linksRes, paySalesRes, candidatesRes] = await Promise.all([
      orderIds.length
        ? supabase.from('order_tax_documents').select('*').in('order_id', orderIds)
        : Promise.resolve({ data: [], error: null }),
      paymentIds.length
        ? supabase.from('payment_sales').select('*').in('payment_id', paymentIds)
        : Promise.resolve({ data: [], error: null }),
      orderIds.length
        ? supabase.from('order_tax_match_candidates').select('*').in('order_id', orderIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const payload = {
      meta: {
        period,
        generated_at: new Date().toISOString(),
        user_id: user.id,
        include_raw: includeRaw,
        counts: {
          orders: orders.length,
          tax_documents: docs.length,
          payments: payments.length,
          order_tax_documents: linksRes.data?.length ?? 0,
          payment_sales: paySalesRes.data?.length ?? 0,
          match_candidates: candidatesRes.data?.length ?? 0,
        },
      },
      sales: orders,
      bsale_documents: docs,
      payments,
      existing_links: {
        order_tax_documents: linksRes.data ?? [],
        payment_sales: paySalesRes.data ?? [],
        match_candidates: candidatesRes.data ?? [],
      },
    };

    let json = JSON.stringify(payload);
    let downgraded = false;
    if (includeRaw && json.length > 10 * 1024 * 1024) {
      // Re-fetch slim if too heavy
      const strip = (rows: any[]) => rows.map((r) => { const { raw_data, ...rest } = r; return rest; });
      payload.sales = strip(payload.sales as any[]);
      payload.bsale_documents = strip(payload.bsale_documents as any[]);
      payload.payments = strip(payload.payments as any[]);
      (payload.meta as any).downgraded_to_slim = true;
      downgraded = true;
      json = JSON.stringify(payload);
    }

    return new Response(json, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="quadra-sample-${period}${downgraded ? '-slim' : ''}.json"`,
      },
    });
  } catch (err: unknown) {
    console.error('export-monthly-sample error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});