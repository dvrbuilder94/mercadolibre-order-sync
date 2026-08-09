import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveUserId } from '../_shared/auth.ts';
import { loadShopifyAccount, shopifyGraphQL, type ShopifyAccount } from '../_shared/shopify-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAGE_SIZE = 25;
const MAX_PAGES = 20;
const TIME_BUDGET_MS = 100_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Solo lectura: productos, variantes y SKU.
const PRODUCTS_QUERY = `
  query SyncProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          title
          status
          vendor
          productType
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json().catch(() => ({}));
    const { account_id: accountIdParam = null, user_id: userIdParam = null, cursor: cursorParam = null } = body;

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );

    const userId = await resolveUserId(req, userClient, userIdParam);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const account: ShopifyAccount | null = await loadShopifyAccount(supabaseClient, userId, accountIdParam);
    if (!account) {
      return new Response(JSON.stringify({ error: 'Shopify no conectado' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let after: string | null = cursorParam;
    let hasNextPage = true;
    let pages = 0;
    let variantsSynced = 0;
    let apiError: string | null = null;
    const startedAt = Date.now();

    while (hasNextPage && pages < MAX_PAGES) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const result = await shopifyGraphQL(supabaseClient, account, PRODUCTS_QUERY, { first: PAGE_SIZE, after });
      if (!result.ok) { apiError = result.error; console.error('Shopify products fetch error:', apiError); break; }

      const edges: any[] = result.data?.products?.edges || [];
      hasNextPage = !!result.data?.products?.pageInfo?.hasNextPage;
      if (edges.length === 0) break;

      const rows: any[] = [];
      for (const edge of edges) {
        const p = edge.node;
        for (const ve of (p.variants?.edges || [])) {
          const v = ve.node;
          rows.push({
            user_id: userId,
            channel_account_id: account.id,
            product_id: p.id,
            variant_id: v.id,
            product_title: p.title ?? null,
            variant_title: v.title ?? null,
            sku: v.sku || null,
            barcode: v.barcode || null,
            price: v.price ? parseFloat(v.price) : null,
            inventory_quantity: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
            status: p.status ?? null,
            vendor: p.vendor ?? null,
            product_type: p.productType ?? null,
            raw_data: { product: { id: p.id, title: p.title }, variant: v },
            updated_at: new Date().toISOString(),
          });
        }
      }

      if (rows.length > 0) {
        const { error } = await supabaseClient
          .from('shopify_products')
          .upsert(rows, { onConflict: 'channel_account_id,variant_id' });
        if (error) console.error('Upsert products error:', error.message);
        else variantsSynced += rows.length;
      }

      after = edges[edges.length - 1].cursor;
      pages++;
      if (hasNextPage) await sleep(400);
    }

    const partial = hasNextPage || !!apiError;
    return new Response(JSON.stringify({
      success: true,
      partial,
      ...(apiError ? { error_detail: apiError } : {}),
      ...(partial && hasNextPage ? { next_cursor: after } : {}),
      variants: variantsSynced,
      pages,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('Error syncing Shopify products:', error?.message);
    return new Response(JSON.stringify({ error: 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
