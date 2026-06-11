import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function createBsaleDownloadStream(params: {
  job: any;
  checkpoint: any;
  sorted: Array<{ name: string }>;
  admin: any;
  tmpDir: string;
}) {
  const { job, checkpoint, sorted, admin, tmpDir } = params;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const generatedAt = new Date().toISOString();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(
          '{' +
          `"source":${JSON.stringify('bsale')},` +
          `"period":${JSON.stringify(job.period)},` +
          `"generated_at":${JSON.stringify(generatedAt)},` +
          `"bsale_account":${JSON.stringify(checkpoint?.account_name ?? null)},` +
          `"date_range_unix":${JSON.stringify(checkpoint?.date_range_unix ?? null)},` +
          `"counts":${JSON.stringify({ fetched_total: checkpoint?.total_docs || 0, by_code_sii: checkpoint?.by_type || {} })},` +
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
          } catch {
            continue;
          }

          for (const doc of arr) {
            const key = String(doc?.id ?? '');
            if (key) {
              if (seen.has(key)) continue;
              seen.add(key);
            }

            controller.enqueue(encoder.encode(`${first ? '' : ','}${JSON.stringify(doc)}`));
            first = false;
          }
        }

        controller.enqueue(encoder.encode(']}'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const jobId = new URL(req.url).searchParams.get('job_id');
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'job_id requerido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: job, error } = await admin
      .from('raw_extraction_jobs')
      .select('id, user_id, source, period, status, checkpoint, chunks_count')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw error;
    if (!job || job.source !== 'bsale') {
      return new Response(JSON.stringify({ error: 'Job no encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const phase = job.checkpoint?.phase;
    if (!['assemble', 'assemble_fallback'].includes(String(phase)) && job.status !== 'done') {
      return new Response(JSON.stringify({ error: 'Archivo aún no está listo para descargar' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tmpDir = `${job.user_id}/.tmp/${job.id}`;
    const { data: list, error: listErr } = await admin.storage.from('raw-extractions').list(tmpDir, { limit: 10000 });
    if (listErr) throw listErr;
    const sorted = (list || []).slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
    if (sorted.length === 0) {
      return new Response(JSON.stringify({ error: 'No hay chunks para descargar' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const stream = createBsaleDownloadStream({ job, checkpoint: job.checkpoint, sorted, admin, tmpDir });
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="bsale-${job.period}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Unknown' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});