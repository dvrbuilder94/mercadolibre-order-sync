import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-resume',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VALID_SII_CODES = [33, 34, 39, 41, 61, 56];
const TIME_BUDGET_MS = 180_000;

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

function chainSelf(jobId: string) {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/raw-extract-bsale`;
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

async function uploadStreamToStorage(path: string, stream: ReadableStream<Uint8Array>) {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/raw-extractions/${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'x-upsert': 'true',
      'Content-Type': 'application/json',
    },
    body: stream,
  });

  if (!response.ok) {
    throw new Error(`Storage final: ${response.status} ${await response.text()}`);
  }
}

function createBsalePayloadStream(params: {
  job: any;
  checkpoint: any;
  sorted: Array<{ name: string }>;
  admin: any;
  tmpDir: string;
}) {
  const { job, checkpoint, sorted, admin, tmpDir } = params;
  const encoder = new TextEncoder();
  const stats = { bytes: 0, docs: 0 };
  const seen = new Set<string>();
  const generatedAt = new Date().toISOString();

  const encode = (chunk: string) => {
    const bytes = encoder.encode(chunk);
    stats.bytes += bytes.byteLength;
    return bytes;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encode(
          '{' +
          `"source":${JSON.stringify('bsale')},` +
          `"period":${JSON.stringify(job.period)},` +
          `"generated_at":${JSON.stringify(generatedAt)},` +
          `"bsale_account":${JSON.stringify(checkpoint.account_name ?? null)},` +
          `"date_range_unix":${JSON.stringify(checkpoint.date_range_unix ?? null)},` +
          `"counts":${JSON.stringify({ fetched_total: checkpoint.total_docs || 0, by_code_sii: checkpoint.by_type || {} })},` +
          '"documents":['
        ));

        let first = true;

        for (const f of sorted) {
          const { data: blob, error } = await admin.storage.from('raw-extractions').download(`${tmpDir}/${f.name}`);
          if (error || !blob) continue;

          let arr: any[] = [];
          try {
            const parsed = JSON.parse(await blob.text());
            if (Array.isArray(parsed)) arr = parsed;
          } catch (_) {
            continue;
          }

          for (const doc of arr) {
            const key = String(doc?.id ?? '');
            if (key) {
              if (seen.has(key)) continue;
              seen.add(key);
            }

            controller.enqueue(encode(`${first ? '' : ','}${JSON.stringify(doc)}`));
            first = false;
            stats.docs += 1;
          }
        }

        controller.enqueue(encode(']}'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { stream, stats };
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
      .from('bsale_accounts')
      .select('id, access_token, client_name, status')
      .eq('user_id', job.user_id)
      .eq('status', 'connected')
      .maybeSingle();
    if (accErr || !account) throw new Error('Cuenta Bsale no conectada');
    const token = account.access_token;

    const [y, m] = job.period.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const dateFrom = chileWallToUnix(y, m, 1, 0, 0, 0);
    const dateTo = chileWallToUnix(y, m, lastDay, 23, 59, 59);

    const checkpoint = job.checkpoint || {
      phase: 'fetch',
      code_index: 0,
      offset: 0,
      total_docs: 0,
      estimated_total: 0,
      by_type: {} as Record<string, number>,
      account_name: account.client_name,
      date_range_unix: { from: dateFrom, to: dateTo },
    };
    let chunksCount = job.chunks_count || 0;

    const tmpDir = `${job.user_id}/.tmp/${jobId}`;
    const buf: any[] = [];
    const limit = 50;

    const flush = async () => {
      if (buf.length === 0) return;
      chunksCount++;
      const name = `bsale-${String(chunksCount).padStart(5, '0')}.json`;
      const { error } = await admin.storage.from('raw-extractions').upload(
        `${tmpDir}/${name}`,
        new Blob([JSON.stringify(buf)], { type: 'application/json' }),
        { upsert: true, contentType: 'application/json' }
      );
      if (error) throw new Error(`Storage chunk: ${error.message}`);
      buf.length = 0;
    };

    const persistCheckpoint = async (stepText: string) => {
      await admin.from('raw_extraction_jobs').update({
        checkpoint,
        chunks_count: chunksCount,
        progress: checkpoint.total_docs,
        total: Math.max(checkpoint.estimated_total, checkpoint.total_docs),
        current_step: stepText,
      }).eq('id', jobId);
    };

    if (checkpoint.phase === 'fetch') {
      while (checkpoint.code_index < VALID_SII_CODES.length) {
        const codeSii = VALID_SII_CODES[checkpoint.code_index];
        const url = `https://api.bsale.cl/v1/documents.json?` +
          `emissiondaterange=[${dateFrom},${dateTo}]` +
          `&codesii=${codeSii}` +
          `&expand=[details,client,document_type,references,coin]` +
          `&limit=${limit}&offset=${checkpoint.offset}`;
        const page = await bsaleFetch(url, token);
        if (page.__error) throw new Error(`Bsale codeSii=${codeSii} ${page.__error}: ${page.__body || ''}`);
        const items = page.items || [];
        const pageCount = page.count || 0;

        if (items.length === 0) {
          checkpoint.code_index++;
          checkpoint.offset = 0;
          await persistCheckpoint(`Bsale codeSii=${codeSii} completo`);
        } else {
          buf.push(...items);
          checkpoint.total_docs += items.length;
          checkpoint.by_type[String(codeSii)] = (checkpoint.by_type[String(codeSii)] || 0) + items.length;
          checkpoint.offset += limit;
          checkpoint.estimated_total = Math.max(checkpoint.estimated_total, pageCount);

          if (checkpoint.offset >= pageCount) {
            checkpoint.code_index++;
            checkpoint.offset = 0;
          }

          if (buf.length >= 500) await flush();

          await persistCheckpoint(
            `Bsale codeSii=${codeSii} ${Math.min(checkpoint.offset, pageCount)}/${pageCount} · total ${checkpoint.total_docs}`
          );

          if (elapsed() > TIME_BUDGET_MS) {
            await flush();
            await persistCheckpoint(`Pausa para reanudar (${checkpoint.total_docs} docs)`);
            chainSelf(jobId);
            return;
          }

          await sleep(180);
        }
      }

      await flush();
      checkpoint.phase = 'assemble';
      await persistCheckpoint('Ensamblando JSON final');
    }

    if (checkpoint.phase === 'assemble') {
      await admin.from('raw_extraction_jobs').update({ current_step: 'Generando archivo final' }).eq('id', jobId);

      const { data: list, error: listErr } = await admin.storage.from('raw-extractions').list(tmpDir, { limit: 10000 });
      if (listErr) throw new Error(`List tmp: ${listErr.message}`);
      const sorted = (list || []).slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
      const filePath = `${job.user_id}/bsale-${job.period}-${jobId}.json`;
      const { stream, stats } = createBsalePayloadStream({ job, checkpoint, sorted, admin, tmpDir });
      await uploadStreamToStorage(filePath, stream);

      // Cleanup tmp
      const toDelete = sorted.map((f: any) => `${tmpDir}/${f.name}`);
      if (toDelete.length) await admin.storage.from('raw-extractions').remove(toDelete);

      await admin.from('raw_extraction_jobs').update({
        status: 'done',
        current_step: `Listo: ${stats.docs} documentos`,
        progress: stats.docs,
        total: stats.docs,
        file_path: filePath,
        file_size_bytes: stats.bytes,
        checkpoint,
      }).eq('id', jobId);
    }
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
      source: 'bsale',
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