import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-resume',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_BUDGET_MS = 180_000;

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

function chainSelf(jobId: string) {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/raw-extract-meli`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-resume': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
    },
    body: JSON.stringify({ job_id: jobId, resume: true }),
  }).catch((e) => console.error('chainSelf failed', e));
}

async function processJob(jobId: string, admin: any) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const { data: job, error: jErr } = await admin.from('raw_extraction_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jErr || !job) { console.error('job not found', jobId, jErr); return; }
  if (job.status === 'done' || job.status === 'error') return;

  await admin.from('raw_extraction_jobs').update({ status: 'running' }).eq('id', jobId);

  try {
    const { data: account, error: accErr } = await admin
      .from('meli_accounts')
      .select('*')
      .eq('user_id', job.user_id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (accErr || !account) throw new Error('Cuenta MercadoLibre no encontrada');
    if (!account.access_token || !account.seller_id) throw new Error('Cuenta ML sin token o seller_id');

    const token = await refreshMeliToken(admin, account);
    const sellerId = account.seller_id;

    const [y, m] = job.period.split('-').map(Number);
    const dateFrom = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const dateTo = new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString();

    const checkpoint = job.checkpoint || {
      phase: 'fetch',
      orders_offset: 0,
      total_orders: 0,
      processed: 0,
      seller_id: sellerId,
    };
    let chunksCount = job.chunks_count || 0;
    const tmpDir = `${job.user_id}/.tmp/${jobId}`;

    const orders: any[] = [];
    const details: any[] = [];
    const shipments: any[] = [];
    const payments: any[] = [];

    const flush = async () => {
      if (!orders.length && !details.length && !shipments.length && !payments.length) return;
      chunksCount++;
      const name = `meli-${String(chunksCount).padStart(5, '0')}.json`;
      const payload = { orders: [...orders], details: [...details], shipments: [...shipments], payments: [...payments] };
      const { error } = await admin.storage.from('raw-extractions').upload(
        `${tmpDir}/${name}`,
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        { upsert: true, contentType: 'application/json' }
      );
      if (error) throw new Error(`Storage chunk: ${error.message}`);
      orders.length = details.length = shipments.length = payments.length = 0;
    };

    const persist = async (step: string) => {
      await admin.from('raw_extraction_jobs').update({
        checkpoint, chunks_count: chunksCount,
        progress: checkpoint.processed,
        total: Math.max(checkpoint.total_orders, checkpoint.processed),
        current_step: step,
      }).eq('id', jobId);
    };

    if (checkpoint.phase === 'fetch') {
      const limit = 50;
      while (true) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc` +
          `&order.date_created.from=${dateFrom}&order.date_created.to=${dateTo}` +
          `&limit=${limit}&offset=${checkpoint.orders_offset}`;
        const page = await meliFetch(url, token);
        if (page.__error) throw new Error(`Orders ${page.__error}: ${page.__body}`);
        const results = page.results || [];
        checkpoint.total_orders = page.paging?.total || checkpoint.total_orders;

        if (results.length === 0) break;

        const concurrency = 4;
        for (let i = 0; i < results.length; i += concurrency) {
          const batch = results.slice(i, i + concurrency);
          await Promise.all(batch.map(async (o: any) => {
            orders.push(o);
            const detail = await meliFetch(`https://api.mercadolibre.com/orders/${o.id}`, token);
            details.push(detail);
            const shipId = detail?.shipping?.id || o?.shipping?.id;
            if (shipId) {
              const ship = await meliFetch(`https://api.mercadolibre.com/shipments/${shipId}`, token);
              shipments.push(ship);
            }
            const payIds: any[] = (detail?.payments || o?.payments || []).map((p: any) => p.id).filter(Boolean);
            for (const pid of payIds) {
              const pay = await meliFetch(`https://api.mercadolibre.com/payments/${pid}`, token);
              payments.push(pay);
            }
          }));
        }

        checkpoint.orders_offset += results.length;
        checkpoint.processed += results.length;

        if (orders.length + details.length >= 400) await flush();

        await persist(`Órdenes+detalles ${checkpoint.processed}/${checkpoint.total_orders}`);

        if (checkpoint.orders_offset >= checkpoint.total_orders) break;

        if (elapsed() > TIME_BUDGET_MS) {
          await flush();
          await persist(`Pausa para reanudar (${checkpoint.processed}/${checkpoint.total_orders})`);
          chainSelf(jobId);
          return;
        }
        await sleep(60);
      }

      await flush();
      checkpoint.phase = 'settlements';
      await persist('Liquidaciones ML');
    }

    if (checkpoint.phase === 'settlements') {
      let settlements: any = null;
      try {
        const sUrl = `https://api.mercadolibre.com/billing/integration/group/ML/marketplace/details?date_from=${dateFrom}&date_to=${dateTo}&limit=150&offset=0`;
        settlements = await meliFetch(sUrl, token);
      } catch (_e) {
        settlements = { __warning: 'settlements_failed' };
      }
      await admin.storage.from('raw-extractions').upload(
        `${tmpDir}/_settlements.json`,
        new Blob([JSON.stringify(settlements)], { type: 'application/json' }),
        { upsert: true, contentType: 'application/json' }
      );
      checkpoint.phase = 'assemble';
      await persist('Ensamblando JSON final');
    }

    if (checkpoint.phase === 'assemble') {
      const { data: list, error: listErr } = await admin.storage.from('raw-extractions').list(tmpDir, { limit: 10000 });
      if (listErr) throw new Error(`List tmp: ${listErr.message}`);

      const allOrders: any[] = [], allDetails: any[] = [], allShipments: any[] = [], allPayments: any[] = [];
      let settlements: any = null;

      const sorted = (list || []).slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
      for (const f of sorted) {
        const { data: blob, error } = await admin.storage.from('raw-extractions').download(`${tmpDir}/${f.name}`);
        if (error || !blob) continue;
        try {
          const parsed = JSON.parse(await blob.text());
          if (f.name === '_settlements.json') { settlements = parsed; continue; }
          if (parsed.orders) allOrders.push(...parsed.orders);
          if (parsed.details) allDetails.push(...parsed.details);
          if (parsed.shipments) allShipments.push(...parsed.shipments);
          if (parsed.payments) allPayments.push(...parsed.payments);
        } catch (_) {}
      }

      const dedupe = (arr: any[]) => {
        const m = new Map<string, any>();
        for (const x of arr) { const k = String(x?.id ?? ''); if (k) m.set(k, x); }
        return Array.from(m.values());
      };
      const orderSummaries = dedupe(allOrders);
      const orderDetails = dedupe(allDetails);
      const ships = dedupe(allShipments);
      const pays = dedupe(allPayments);

      const payload = {
        source: 'mercadolibre',
        period: job.period,
        generated_at: new Date().toISOString(),
        seller_id: checkpoint.seller_id,
        counts: { orders: orderDetails.length, shipments: ships.length, payments: pays.length },
        orders: orderDetails,
        orders_summary: orderSummaries,
        shipments: ships,
        payments: pays,
        settlements,
      };
      const json = JSON.stringify(payload);
      const filePath = `${job.user_id}/meli-${job.period}-${jobId}.json`;
      const { error: upErr } = await admin.storage
        .from('raw-extractions')
        .upload(filePath, new Blob([json], { type: 'application/json' }), {
          contentType: 'application/json',
          upsert: true,
        });
      if (upErr) throw new Error(`Storage final: ${upErr.message}`);

      const toDelete = sorted.map((f: any) => `${tmpDir}/${f.name}`);
      if (toDelete.length) await admin.storage.from('raw-extractions').remove(toDelete);

      await admin.from('raw_extraction_jobs').update({
        status: 'done',
        current_step: `Listo: ${orderDetails.length} órdenes`,
        progress: orderDetails.length,
        total: orderDetails.length,
        file_path: filePath,
        file_size_bytes: json.length,
        checkpoint,
      }).eq('id', jobId);
    }
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
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const internal = req.headers.get('x-internal-resume') === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (internal && body?.resume && body?.job_id) {
      // @ts-ignore
      EdgeRuntime.waitUntil(processJob(body.job_id, admin));
      return new Response(JSON.stringify({ resumed: body.job_id }), {
        status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const period: string = body.period;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return new Response(JSON.stringify({ error: 'period (YYYY-MM) requerido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: job, error: jobErr } = await admin.from('raw_extraction_jobs').insert({
      user_id: user.id,
      source: 'meli',
      period,
      status: 'pending',
      current_step: 'Encolado',
      checkpoint: null,
      chunks_count: 0,
    }).select('id').single();
    if (jobErr || !job) throw new Error(jobErr?.message || 'No se pudo crear el job');

    // @ts-ignore
    EdgeRuntime.waitUntil(processJob(job.id, admin));

    return new Response(JSON.stringify({ job_id: job.id }), {
      status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Unknown' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});