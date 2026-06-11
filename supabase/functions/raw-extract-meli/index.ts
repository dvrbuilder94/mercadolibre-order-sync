import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshMeliToken(admin: any, account: any): Promise<string> {
  if (account.expires_at && new Date(account.expires_at) > new Date(Date.now() + 60_000)) {
    return account.access_token;
  }
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: account.client_id,
      client_secret: account.client_secret,
      refresh_token: account.refresh_token,
    }),
  });
  if (!r.ok) return account.access_token;
  const d = await r.json();
  await admin.from('meli_accounts').update({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: new Date(Date.now() + d.expires_in * 1000).toISOString(),
  }).eq('id', account.id);
  return d.access_token;
}

async function meliFetch(url: string, token: string, retries = 2): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(500 * (i + 1)); continue; }
      return { __error: r.status, __body: (await r.text()).slice(0, 300) };
    } catch (e: any) {
      if (i === retries) return { __error: 'fetch_failed', __body: e?.message || '' };
      await sleep(500 * (i + 1));
    }
  }
  return { __error: 'exhausted' };
}

async function runExtraction(jobId: string, userId: string, period: string, admin: any) {
  const update = (patch: any) =>
    admin.from('raw_extraction_jobs').update(patch).eq('id', jobId);

  try {
    await update({ status: 'running', current_step: 'Cargando credenciales ML' });

    const { data: account, error: accErr } = await admin
      .from('meli_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (accErr || !account) throw new Error('Cuenta MercadoLibre no encontrada');
    if (!account.access_token || !account.seller_id) throw new Error('Cuenta ML sin token o seller_id');

    const token = await refreshMeliToken(admin, account);
    const sellerId = account.seller_id;

    const [y, m] = period.split('-').map(Number);
    const dateFrom = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const dateTo = new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString();

    // 1. Orders paginated
    await update({ current_step: 'Listando órdenes ML' });
    const orders: any[] = [];
    let offset = 0;
    const limit = 50;
    let total = 0;
    while (true) {
      const url = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc` +
        `&order.date_created.from=${dateFrom}&order.date_created.to=${dateTo}` +
        `&limit=${limit}&offset=${offset}`;
      const page = await meliFetch(url, token);
      if (page.__error) throw new Error(`Orders ${page.__error}: ${page.__body}`);
      const results = page.results || [];
      total = page.paging?.total || 0;
      orders.push(...results);
      if (results.length === 0 || offset + limit >= total) break;
      offset += limit;
      await update({ current_step: `Órdenes ${orders.length}/${total}`, total, progress: orders.length });
      await sleep(80);
    }

    // 2. Order details + shipments + payments
    await update({ current_step: `Detalles 0/${orders.length}`, total: orders.length, progress: 0 });
    const orderDetails: any[] = [];
    const shipments: Record<string, any> = {};
    const payments: Record<string, any> = {};
    const concurrency = 4;
    let done = 0;
    for (let i = 0; i < orders.length; i += concurrency) {
      const batch = orders.slice(i, i + concurrency);
      await Promise.all(batch.map(async (o) => {
        const detail = await meliFetch(`https://api.mercadolibre.com/orders/${o.id}`, token);
        orderDetails.push(detail);
        const shipId = detail?.shipping?.id || o?.shipping?.id;
        if (shipId && !shipments[shipId]) {
          shipments[shipId] = await meliFetch(`https://api.mercadolibre.com/shipments/${shipId}`, token);
        }
        const payIds: any[] = (detail?.payments || o?.payments || []).map((p: any) => p.id).filter(Boolean);
        for (const pid of payIds) {
          if (!payments[pid]) {
            payments[pid] = await meliFetch(`https://api.mercadolibre.com/payments/${pid}`, token);
          }
        }
      }));
      done += batch.length;
      if (done % 20 === 0 || done === orders.length) {
        await update({ current_step: `Detalles ${done}/${orders.length}`, progress: done });
      }
      await sleep(50);
    }

    // 3. Settlements (best-effort, doesn't fail extraction)
    await update({ current_step: 'Liquidaciones ML' });
    let settlements: any = null;
    try {
      const sUrl = `https://api.mercadolibre.com/billing/integration/group/ML/marketplace/details?date_from=${dateFrom}&date_to=${dateTo}&limit=150&offset=0`;
      settlements = await meliFetch(sUrl, token);
    } catch (e) {
      settlements = { __warning: 'settlements_failed' };
    }

    // 4. Build payload + upload
    await update({ current_step: 'Generando JSON' });
    const payload = {
      source: 'mercadolibre',
      period,
      generated_at: new Date().toISOString(),
      seller_id: sellerId,
      counts: {
        orders: orderDetails.length,
        shipments: Object.keys(shipments).length,
        payments: Object.keys(payments).length,
      },
      orders: orderDetails,
      shipments: Object.values(shipments),
      payments: Object.values(payments),
      settlements,
    };
    const json = JSON.stringify(payload);
    const filePath = `${userId}/meli-${period}-${jobId}.json`;
    const { error: upErr } = await admin.storage
      .from('raw-extractions')
      .upload(filePath, new Blob([json], { type: 'application/json' }), {
        contentType: 'application/json',
        upsert: true,
      });
    if (upErr) throw new Error(`Storage: ${upErr.message}`);

    await update({
      status: 'done',
      current_step: `Listo: ${orderDetails.length} órdenes`,
      progress: orderDetails.length,
      total: orderDetails.length,
      file_path: filePath,
      file_size_bytes: json.length,
    });
  } catch (e: any) {
    console.error('raw-extract-meli error:', e);
    await admin.from('raw_extraction_jobs').update({
      status: 'error',
      error_message: e?.message || String(e),
    }).eq('id', jobId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json().catch(() => ({}));
    const period: string = body.period;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return new Response(JSON.stringify({ error: 'period (YYYY-MM) requerido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: job, error: jobErr } = await admin.from('raw_extraction_jobs').insert({
      user_id: user.id,
      source: 'meli',
      period,
      status: 'pending',
      current_step: 'Encolado',
    }).select('id').single();
    if (jobErr || !job) throw new Error(jobErr?.message || 'No se pudo crear el job');

    // Background execution
    // @ts-ignore — EdgeRuntime is provided by Supabase edge runtime
    EdgeRuntime.waitUntil(runExtraction(job.id, user.id, period, admin));

    return new Response(JSON.stringify({ job_id: job.id }), {
      status: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Unknown' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});