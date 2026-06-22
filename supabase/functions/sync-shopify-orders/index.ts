import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveUserId } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Quarterly Shopify API version (YYYY-MM). Keep in sync with connect-shopify.
const SHOPIFY_API_VERSION = '2026-04';
const FETCH_TIMEOUT_MS = 20_000;
const TIME_BUDGET_MS = 100_000; // margen bajo el límite (~150s) de Edge Functions
const PAGE_SIZE = 50;
const MAX_PAGES_PER_INVOCATION = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// REST Admin API is legacy (since Oct 2024); GraphQL is what Shopify steers
// all new development to, including custom apps, so the sync uses it
// exclusively rather than mixing both.
const ORDERS_QUERY = `
  query SyncOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          email
          createdAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          customer { displayName }
          billingAddress { name }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          lineItems(first: 5) {
            edges { node { title sku } }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

async function fetchShopifyGraphQL(shopDomain: string, accessToken: string, query: string, variables: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      const rawText = await response.text().catch(() => '');

      if (response.status === 429) {
        if (attempt < 2) {
          console.warn('Shopify rate limit (429), retrying...');
          await sleep(1500 * attempt);
          continue;
        }
        return { ok: false as const, error: 'Shopify rate limit (429)' };
      }

      if (!response.ok) {
        return { ok: false as const, error: `Shopify API ${response.status}`, detail: rawText.slice(0, 300) };
      }

      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        return { ok: false as const, error: 'Shopify API invalid JSON', detail: rawText.slice(0, 300) };
      }

      if (data.errors) {
        const throttled = data.errors.some((e: any) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt < 2) {
          console.warn('Shopify GraphQL THROTTLED, retrying...');
          await sleep(1500 * attempt);
          continue;
        }
        return { ok: false as const, error: 'Shopify GraphQL error', detail: JSON.stringify(data.errors).slice(0, 300) };
      }

      return { ok: true as const, data: data.data };
    } catch (e: any) {
      const error = e?.name === 'AbortError'
        ? `Shopify fetch timeout (${FETCH_TIMEOUT_MS}ms)`
        : `fetch failed: ${e?.message || 'network'}`;

      if (attempt < 2) {
        console.warn(`${error}, retrying...`);
        await sleep(500 * attempt);
        continue;
      }
      return { ok: false as const, error };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { ok: false as const, error: 'Shopify fetch failed' };
}

// Maps a Shopify Order (GraphQL) node to our multi-channel `orders` schema.
// Unlike MELI, Shopify isn't a marketplace that takes a per-order commission
// — its costs are a flat subscription + payment-gateway fees, neither of
// which is visible per-order via this API. So gross == net here; there is no
// commission_amount to estimate, and no later "exact data" enrichment step.
function transformOrder(order: any, shopifyAccountId: string) {
  const money = order.currentTotalPriceSet?.shopMoney || {};
  const amount = parseFloat(money.amount ?? '0');
  const currency = money.currencyCode || 'CLP';
  const shippingCost = parseFloat(order.totalShippingPriceSet?.shopMoney?.amount ?? '0');
  const taxAmount = parseFloat(order.totalTaxSet?.shopMoney?.amount ?? '0');
  const discountAmount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount ?? '0');

  let status = 'pending';
  if (order.cancelledAt) status = 'cancelled';
  else if (order.displayFulfillmentStatus === 'FULFILLED') status = 'delivered';
  else if (order.displayFulfillmentStatus === 'PARTIALLY_FULFILLED' || order.displayFulfillmentStatus === 'IN_PROGRESS') status = 'shipped';
  else if (order.displayFinancialStatus === 'PAID' || order.displayFinancialStatus === 'PARTIALLY_PAID') status = 'confirmed';

  const firstLineItem = order.lineItems?.edges?.[0]?.node;
  const orderId = order.legacyResourceId?.toString() || order.id;

  return {
    channel: 'shopify',
    channel_account_id: shopifyAccountId,
    order_id: orderId,
    customer_name: order.customer?.displayName || order.billingAddress?.name || order.email || 'Cliente',
    customer_email: order.email || null,
    order_date: order.createdAt,
    amount,
    status,
    items: order.lineItems?.edges?.length || 1,
    raw_data: order,

    gross_amount: amount,
    net_amount: amount,
    commission_percentage: 0,
    commission_amount: 0,
    payment_method: 'shopify_payments',
    payment_approved_at: order.createdAt,
    expected_payment_date: order.createdAt,
    has_exact_data: false,

    settlement_date: order.createdAt,
    settlement_amount: Math.round((amount - shippingCost) * 100) / 100,
    bank_reference: `SHOPIFY-${orderId}`,
    shipping_cost: shippingCost,
    discount_amount: discountAmount,
    currency_id: currency,
    tax_amount: taxAmount,

    product_title: firstLineItem?.title || null,
    seller_sku: firstLineItem?.sku || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json().catch(() => ({}));
    const {
      date_from = null,
      date_to = null,
      max_pages = 10,
      account_id: accountIdParam = null,
      user_id: userIdParam = null,
      cursor: cursorParam = null,
    } = body;

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
    );

    const userId = await resolveUserId(req, userClient, userIdParam);
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const user = { id: userId };

    let accountQuery = supabaseClient
      .from('shopify_accounts')
      .select('id, shop_domain, access_token, status')
      .eq('user_id', user.id)
      .eq('status', 'connected');
    if (accountIdParam) accountQuery = accountQuery.eq('id', accountIdParam);

    const { data: shopifyAccount, error: accountError } = await accountQuery.maybeSingle();

    if (accountError || !shopifyAccount) {
      console.error('Shopify account not found or not connected:', accountError);
      return new Response(
        JSON.stringify({
          error: 'Shopify no conectado',
          message: 'Por favor conecta tu cuenta Shopify en Configuración',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // The read_orders scope only exposes the last 60 days by default
    // (read_all_orders is required for full history) — default to that
    // window so a bare call doesn't silently return nothing.
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const dateFromIso = date_from ? new Date(date_from).toISOString() : defaultFrom.toISOString();
    const dateToIso = date_to ? new Date(date_to).toISOString() : null;

    let searchQuery = `created_at:>='${dateFromIso}'`;
    if (dateToIso) searchQuery += ` AND created_at:<='${dateToIso}'`;

    console.log('=== SYNC SHOPIFY ORDERS START ===');
    console.log('User ID:', user.id, '| Shop:', shopifyAccount.shop_domain, '| Query:', searchQuery);

    let afterCursor: string | null = cursorParam;
    let hasNextPage = true;
    let pagesThisRun = 0;
    let totalFetched = 0;
    let syncedCount = 0;
    let errorCount = 0;
    let timedOut = false;
    let apiError: string | null = null;
    const startedAt = Date.now();
    const maxPagesThisRun = Math.min(Number(max_pages) || MAX_PAGES_PER_INVOCATION, MAX_PAGES_PER_INVOCATION);

    while (hasNextPage && pagesThisRun < maxPagesThisRun) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        console.log(`⏱️ Time budget (${TIME_BUDGET_MS}ms) exceeded, stopping early`);
        timedOut = true;
        break;
      }

      const result = await fetchShopifyGraphQL(shopifyAccount.shop_domain, shopifyAccount.access_token, ORDERS_QUERY, {
        first: PAGE_SIZE,
        after: afterCursor,
        query: searchQuery,
      });

      if (!result.ok) {
        apiError = result.error;
        console.error('Shopify fetch error:', apiError, result.detail);
        break;
      }

      const edges: any[] = result.data?.orders?.edges || [];
      hasNextPage = !!result.data?.orders?.pageInfo?.hasNextPage;
      totalFetched += edges.length;

      console.log(`Page ${pagesThisRun + 1}: fetched ${edges.length} orders`);

      if (edges.length === 0) break;

      const rows: any[] = [];
      for (const edge of edges) {
        try {
          rows.push(transformOrder(edge.node, shopifyAccount.id));
        } catch (error) {
          console.error(`❌ Error processing order ${edge.node?.id}:`, error);
          errorCount++;
        }
      }

      if (rows.length > 0) {
        const { data: upserted, error: upsertError } = await supabaseClient
          .from('orders')
          .upsert(rows, {
            onConflict: 'channel_account_id,order_id',
            ignoreDuplicates: false,
          })
          .select('id');

        if (upsertError) {
          console.error('❌ Upsert error:', upsertError);
          errorCount += rows.length;
        } else {
          syncedCount += upserted?.length || rows.length;
        }
      }

      afterCursor = edges[edges.length - 1].cursor;
      pagesThisRun++;

      if (hasNextPage) await sleep(500); // margen para el rate limit cost-based de la GraphQL Admin API
    }

    console.log('\n=== SYNC SUMMARY ===');
    console.log(`Total fetched: ${totalFetched}`);
    console.log(`Successfully synced: ${syncedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Pages this run: ${pagesThisRun}`);
    if (timedOut) console.log('⏱️ Stopped early due to time budget');
    if (apiError) console.log(`⚠️ Stopped due to Shopify API error: ${apiError}`);

    const partial = timedOut || !!apiError || hasNextPage;

    return new Response(
      JSON.stringify({
        success: true,
        message: partial
          ? 'Sincronización parcial de Shopify (volvé a correrla para continuar)'
          : 'Sincronización de Shopify completada',
        partial,
        ...(apiError ? { error_detail: apiError } : {}),
        ...(partial && hasNextPage ? { next_cursor: afterCursor } : {}),
        total: totalFetched,
        synced: syncedCount,
        errors: errorCount,
        pages: pagesThisRun,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing Shopify orders:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
