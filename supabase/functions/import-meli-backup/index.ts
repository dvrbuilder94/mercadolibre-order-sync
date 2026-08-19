import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { resolveUserId } from '../_shared/auth.ts';
import { getMeliAccount } from '../_shared/meli-account.ts';
import { mapMeliOrderStatus } from '../_shared/order-status.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );

    const body = await req.json().catch(() => ({}));
    const orders = Array.isArray(body?.orders) ? body.orders : [];
    const sellerId = body?.seller_id != null ? String(body.seller_id) : null;
    const accountIdParam = body?.account_id ?? null;

    if (orders.length === 0) return json({ success: false, error: 'No se recibieron órdenes' }, 400);
    if (orders.length > 100) return json({ success: false, error: 'Máximo 100 órdenes por lote' }, 400);

    const userId = await resolveUserId(req, supabase, null);
    if (!userId) return json({ success: false, error: 'No autorizado' }, 401);

    const { data: meliAccount, error: accountError } = await getMeliAccount(supabase, userId, {
      accountId: accountIdParam,
      orderBy: 'updated_at',
      maybeSingle: true,
    });

    if (accountError || !meliAccount) {
      return json({ success: false, error: 'No hay una cuenta Mercado Libre configurada en Quadra' }, 400);
    }

    if (sellerId && meliAccount.seller_id && String(meliAccount.seller_id) !== sellerId) {
      return json({
        success: false,
        error: `El respaldo pertenece al seller ${sellerId}, pero la cuenta conectada es ${meliAccount.seller_id}`,
      }, 400);
    }

    const ids = orders
      .map((order: any) => order?.id != null ? String(order.id) : null)
      .filter(Boolean) as string[];

    if (ids.length !== orders.length) {
      return json({ success: false, error: 'Hay órdenes sin order.id válido' }, 400);
    }

    const { data: existingExact, error: exactError } = await supabase
      .from('orders')
      .select('order_id')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .in('order_id', ids)
      .eq('has_exact_data', true);

    if (exactError) throw exactError;
    const exactIds = new Set((existingExact || []).map((row: any) => String(row.order_id)));

    const splitRut = (rut: string | null | undefined) => {
      if (!rut) return { body: null, dv: null };
      const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
      if (clean.length < 7) return { body: null, dv: null };
      return { body: clean.slice(0, -1), dv: clean.slice(-1) };
    };

    const transform = (order: any) => {
      const buyer = order.buyer || {};
      const billingInfo = buyer.billing_info || {};
      const rawRut = billingInfo.doc_number || billingInfo.docNumber || null;
      const { body: customerTaxId, dv: customerTaxIdDv } = splitRut(rawRut);
      const shipping = order.shipping || {};
      const coupon = order.coupon || {};
      const firstItem = order.order_items?.[0];
      const preserveExact = exactIds.has(String(order.id));

      const row: Record<string, unknown> = {
        channel: 'meli',
        channel_account_id: meliAccount.id,
        meli_account_id: meliAccount.id,
        order_id: String(order.id),
        customer_name: buyer.nickname || 'Cliente',
        customer_email: buyer.email || null,
        customer_tax_id: customerTaxId,
        customer_tax_id_dv: customerTaxIdDv,
        order_date: new Date(order.date_created).toISOString(),
        amount: Number(order.total_amount || 0),
        gross_amount: Number(order.total_amount || 0),
        status: mapMeliOrderStatus(order),
        items: order.order_items?.length || 1,
        raw_data: order,
        shipping_cost: Number(shipping.cost || 0),
        discount_amount: Number(coupon.amount || 0),
        currency_id: order.currency_id || 'CLP',
        shipping_mode: shipping.shipping_mode || null,
        shipping_id: shipping.id != null ? String(shipping.id) : null,
        date_shipped: shipping.date_shipped || null,
        date_delivered: shipping.date_delivered || null,
        seller_sku: firstItem?.item?.seller_custom_field || null,
        product_title: firstItem?.item?.title || null,
      };

      if (!preserveExact) row.has_exact_data = false;
      return row;
    };

    const rows = orders.map(transform);
    const normalRows = rows.filter((_, index) => !exactIds.has(String(orders[index].id)));
    const preservedRows = rows.filter((_, index) => exactIds.has(String(orders[index].id)));

    let synced = 0;
    for (const batch of [normalRows, preservedRows]) {
      if (batch.length === 0) continue;
      const { data, error } = await supabase
        .from('orders')
        .upsert(batch, { onConflict: 'channel_account_id,order_id', ignoreDuplicates: false })
        .select('id');
      if (error) throw error;
      synced += data?.length || batch.length;
    }

    return json({
      success: true,
      received: orders.length,
      synced,
      preserved_exact: preservedRows.length,
      account_id: meliAccount.id,
      seller_id: meliAccount.seller_id,
    });
  } catch (error: any) {
    console.error('import-meli-backup error', error);
    return json({ success: false, error: error?.message || 'Error importando respaldo MELI' }, 500);
  }
});
