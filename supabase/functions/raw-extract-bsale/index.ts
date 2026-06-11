import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VALID_SII_CODES = [33, 34, 39, 41, 61, 56];

// Convert Chile wall-clock to unix seconds (DST-aware).
function chileWallToUnix(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  let ts = Date.UTC(y, mo - 1, d, h, mi, s);
  const target = ts;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const curr = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const diff = target - curr;
    if (diff === 0) break;
    ts += diff;
  }
  return Math.floor(ts / 1000);
}

async function bsaleFetch(url: string, token: string, retries = 2): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { access_token: token, 'Content-Type': 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(600 * (i + 1)); continue; }
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
    await update({ status: 'running', current_step: 'Cargando credenciales Bsale' });

    const { data: account, error: accErr } = await admin
      .from('bsale_accounts')
      .select('id, access_token, client_name, status')
      .eq('user_id', userId)
      .eq('status', 'connected')
      .maybeSingle();
    if (accErr || !account) throw new Error('Cuenta Bsale no conectada');

    const token = account.access_token;

    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const dateFrom = chileWallToUnix(y, m, 1, 0, 0, 0);
    const dateTo = chileWallToUnix(y, m, lastDay, 23, 59, 59);

    const allDocs: any[] = [];
    const limit = 50;
    const byType: Record<string, number> = {};
    let totalEstimated = 0;

    for (const codeSii of VALID_SII_CODES) {
      let offset = 0;
      await update({ current_step: `Bsale codeSii=${codeSii} (${allDocs.length} docs)` });
      while (true) {
        const url = `https://api.bsale.cl/v1/documents.json?` +
          `emissiondaterange=[${dateFrom},${dateTo}]` +
          `&codesii=${codeSii}` +
          `&expand=[details,client,document_type,references,coin]` +
          `&limit=${limit}&offset=${offset}`;
        const page = await bsaleFetch(url, token);
        if (page.__error) throw new Error(`Bsale codeSii=${codeSii} ${page.__error}: ${page.__body || ''}`);
        const items = page.items || [];
        if (items.length === 0) break;
        allDocs.push(...items);
        byType[String(codeSii)] = (byType[String(codeSii)] || 0) + items.length;
        totalEstimated = page.count || totalEstimated;
        offset += limit;
        await update({
          current_step: `Bsale codeSii=${codeSii} ${offset} / ${page.count ?? '?'}`,
          progress: allDocs.length,
          total: Math.max(totalEstimated, allDocs.length),
        });
        if (offset >= (page.count || 0)) break;
        await sleep(180);
      }
    }

    await update({ current_step: 'Generando JSON' });
    const payload = {
      source: 'bsale',
      period,
      generated_at: new Date().toISOString(),
      bsale_account: account.client_name,
      date_range_unix: { from: dateFrom, to: dateTo },
      counts: { total: allDocs.length, by_code_sii: byType },
      documents: allDocs,
    };
    const json = JSON.stringify(payload);
    const filePath = `${userId}/bsale-${period}-${jobId}.json`;
    const { error: upErr } = await admin.storage
      .from('raw-extractions')
      .upload(filePath, new Blob([json], { type: 'application/json' }), {
        contentType: 'application/json',
        upsert: true,
      });
    if (upErr) throw new Error(`Storage: ${upErr.message}`);

    await update({
      status: 'done',
      current_step: `Listo: ${allDocs.length} documentos`,
      progress: allDocs.length,
      total: allDocs.length,
      file_path: filePath,
      file_size_bytes: json.length,
    });
  } catch (e: any) {
    console.error('raw-extract-bsale error:', e);
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
      source: 'bsale',
      period,
      status: 'pending',
      current_step: 'Encolado',
    }).select('id').single();
    if (jobErr || !job) throw new Error(jobErr?.message || 'No se pudo crear el job');

    // @ts-ignore
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