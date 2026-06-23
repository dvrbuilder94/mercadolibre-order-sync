import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { refreshMeliAccountToken } from '../_shared/meli-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Refresh ALL Mercado Libre tokens that expire within the next 12 hours.
// Runs on a pg_cron schedule (no JWT required, uses service role).
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const threshold = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  const { data: accounts, error } = await supabase
    .from('meli_accounts')
    .select('id, user_id, client_id, client_secret, refresh_token, expires_at, seller_id')
    .or(`expires_at.is.null,expires_at.lt.${threshold}`);

  if (error) {
    console.error('Error listing meli_accounts:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  console.log(`[cron-refresh-meli] Found ${accounts?.length ?? 0} accounts to refresh`);

  const results: Array<{ account_id: string; ok: boolean; error?: string }> = [];

  for (const acc of accounts ?? []) {
    if (!acc.refresh_token || !acc.client_id || !acc.client_secret) {
      results.push({ account_id: acc.id, ok: false, error: 'missing credentials' });
      continue;
    }

    try {
      const { expires_at } = await refreshMeliAccountToken(supabase, acc);
      console.log(`[cron-refresh-meli] ${acc.id} refreshed, new expiry ${expires_at}`);
      results.push({ account_id: acc.id, ok: true });
    } catch (e: any) {
      console.error(`[cron-refresh-meli] ${acc.id} threw:`, e);
      results.push({ account_id: acc.id, ok: false, error: e?.message ?? String(e) });
    }

    // gentle pacing
    await new Promise(r => setTimeout(r, 200));
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`[cron-refresh-meli] ${failed.length}/${results.length} refreshes failed`);
  }

  return new Response(
    JSON.stringify({
      success: failed.length === 0,
      total: results.length,
      refreshed: results.length - failed.length,
      failed: failed.length,
      details: results,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});