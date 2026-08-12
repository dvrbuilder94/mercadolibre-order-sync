import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getMeliAccount, getFreshAccessToken } from '../_shared/meli-account.ts';
import { resolveUserId } from '../_shared/auth.ts';
import { mapMeliOrderStatus } from '../_shared/order-status.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    let dateFromParam: string | null = null;
    let dateToParam: string | null = null;
    let maxPagesParam = 10;
    let accountIdParam: string | null = null;
    let userIdParam: string | null = null;

    try {
      const body = await req.json();
      dateFromParam = body.date_from || null;
      dateToParam = body.date_to || null;
      maxPagesParam = body.max_pages || 10;
      accountIdParam = body.account_id || null;
      userIdParam = body.user_id || null;
    } catch {
      // No body or invalid JSON, use defaults.
    }

    const userId = await resolveUserId(req, supabaseClient, userIdParam);
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: meliAccount, error: accountError } = await getMeliAccount(supabaseClient, userId, {
      accountId: accountIdParam,
    });

    console.log('=== SYNC MELI ORDERS ===');
    console.log('User ID:', userId);
    console.log('MELI Account:', {
      id: meliAccount?.id,
      seller_id: meliAccount?.seller_id,
      site_id: meliAccount?.site_id,
      has_access_token: !!meliAccount?.access_token,
    });

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!meliAccount.access_token || !meliAccount.seller_id) {
      return new Response(
        JSON.stringify({ error: 'Account not authenticated. Please authenticate first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let accessToken: string;
    try {
      accessToken = await getFreshAccessToken(supabaseClient, meliAccount);
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: e?.message ?? 'Failed to refresh token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const sellerId = meliAccount.seller_id;
    let dateFrom: string;
    if (dateFromParam) {
      dateFrom = new Date(dateFromParam).toISOString();
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      dateFrom = thirtyDaysAgo.toISOString();
    }
    const dateTo = dateToParam ? new Date(dateToParam).toISOString() : null;

    const splitRut = (rut: string | null | undefined): { body: string | null; dv: string | null } => {
      if (!rut) return { body: null, dv: null };
      const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
      if (clean.length < 7) return { body: null, dv: null };
      return { body: clean.slice(0, -1), dv: clean.slice(-1) };
    };

    // Orders is the commercial source-of-truth layer.
    // Do not fabricate payment, commission, release or settlement values here.
    // Mercado Pago enrichment owns those values in sync-meli-payment-details.
    const transformOrder = (order: any, preserveExact: boolean) => {
      const buyer = order.buyer || {};
      const billingInfo = buyer.billing_info || {};
      const rawRut = billingInfo.doc_number || billingInfo.docNumber || null;
      const { body: customerTaxId, dv: customerTaxIdDv } = splitRut(rawRut);
      const shipping = order.shipping || {};
      const coupon = order.coupon || {};
      const firstItem = order.order_items?.[0];

      const commercialRow: Record<string, unknown> = {
        channel: 'meli',
        channel_account_id: meliAccount.id,
        meli_account_id: meliAccount.id,
        order_id: order.id.toString(),
        customer_name: buyer.nickname || 'Cliente',
        customer_email: buyer.email || null,
        customer_tax_id: customerTaxId,
        customer_tax_id_dv: customerTaxIdDv,
        order_date: new Date(order.date_created).toISOString(),
        amount: order.total_amount || 0,
        // Kept as the canonical commercial gross currently consumed by the UI.
        // It is a direct copy of MELI total_amount, never an estimate.
        gross_amount: order.total_amount || 0,
        status: mapMeliOrderStatus(order),
        items: order.order_items?.length || 1,
        raw_data: order,
        shipping_cost: shipping.cost || 0,
        discount_amount: coupon.amount || 0,
        currency_id: order.currency_id || 'CLP',
        shipping_mode: shipping.shipping_mode || null,
        shipping_id: shipping.id?.toString() || null,
        date_shipped: shipping.date_shipped || null,
        date_delivered: shipping.date_delivered || null,
        seller_sku: firstItem?.item?.seller_custom_field || null,
        product_title: firstItem?.item?.title || null,
      };

      // New/non-enriched orders must be eligible for the MP enrichment worker.
      // For an already enriched order we omit this flag entirely so routine
      // order syncs cannot reset exact financial data.
      if (!preserveExact) commercialRow.has_exact_data = false;

      return commercialRow;
    };

    let offset = 0;
    const limit = 50;
    const maxPages = Math.min(maxPagesParam, 50);
    let currentPage = 0;
    let totalAvailable = 0;
    let totalFetched = 0;
    let syncedCount = 0;
    let errorCount = 0;
    let timedOut = false;
    const startedAt = Date.now();
    const TIME_BUDGET_MS = 100_000;

    while (currentPage < maxPages) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }

      const dateToFilter = dateTo ? `&order.date_created.to=${dateTo}` : '';
      const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc&order.date_created.from=${dateFrom}${dateToFilter}&limit=${limit}&offset=${offset}`;
      const ordersResponse = await fetch(ordersUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!ordersResponse.ok) {
        console.error('Error fetching orders:', ordersResponse.status, await ordersResponse.text());
        errorCount++;
        break;
      }

      const ordersPage = await ordersResponse.json();
      const orders = ordersPage.results || [];
      totalAvailable = ordersPage.paging?.total || 0;
      if (orders.length === 0) break;
      totalFetched += orders.length;

      const pageOrderIds = orders.map((o: any) => o.id.toString());
      const { data: exactRows, error: exactError } = await supabaseClient
        .from('orders')
        .select('order_id')
        .eq('channel_account_id', meliAccount.id)
        .eq('channel', 'meli')
        .in('order_id', pageOrderIds)
        .eq('has_exact_data', true);

      if (exactError) {
        console.error('Error checking exact orders:', exactError);
        errorCount += orders.length;
        break;
      }

      const exactOrderIds = new Set((exactRows || []).map((r: any) => r.order_id));
      const normalRows: any[] = [];
      const exactPreservedRows: any[] = [];

      for (const order of orders) {
        try {
          const isExact = exactOrderIds.has(order.id.toString());
          const transformed = transformOrder(order, isExact);
          (isExact ? exactPreservedRows : normalRows).push(transformed);
        } catch (error) {
          console.error(`Error processing order ${order.id}:`, error);
          errorCount++;
        }
      }

      let pageSynced = 0;
      for (const [label, rows] of [
        ['commercial', normalRows],
        ['commercial-preserve-exact', exactPreservedRows],
      ] as const) {
        if (rows.length === 0) continue;
        const { data: upserted, error: upsertError } = await supabaseClient
          .from('orders')
          .upsert(rows, {
            onConflict: 'channel_account_id,order_id',
            ignoreDuplicates: false,
          })
          .select('id');

        if (upsertError) {
          console.error(`Error upserting page ${currentPage + 1} (${label}):`, upsertError);
          errorCount += rows.length;
        } else {
          pageSynced += upserted?.length || rows.length;
        }
      }

      syncedCount += pageSynced;
      console.log(`Page ${currentPage + 1}: synced ${pageSynced} commercial orders`);

      if (offset + limit >= totalAvailable) break;
      offset += limit;
      currentPage++;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Billing enrichment is still commercial data (buyer identity/RUT), so it
    // remains part of the orders pipeline.
    if (syncedCount > 0) {
      try {
        supabaseClient.functions.invoke('enrich-meli-billing', {
          body: { account_id: meliAccount.id, user_id: userId },
        }).catch((e) => console.error('enrich-meli-billing invoke failed:', e));
      } catch (e) {
        console.error('enrich-meli-billing threw:', e);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: timedOut
          ? 'Sincronización parcial (límite de tiempo alcanzado)'
          : 'Sincronización completada',
        total: totalFetched,
        synced: syncedCount,
        errors: errorCount,
        pages: currentPage + 1,
        available: totalAvailable,
        partial: timedOut,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error syncing orders:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
