import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

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

    const url = new URL(req.url);
    let jobId = url.searchParams.get('job_id');
    let source = url.searchParams.get('source');
    let period = url.searchParams.get('period');
    if (!jobId && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      jobId = body.job_id || null;
      source = source || body.source || null;
      period = period || body.period || null;
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let q = admin.from('raw_extraction_jobs')
      .select('id, source, period, status, current_step, progress, total, file_path, file_size_bytes, error_message, created_at, updated_at')
      .eq('user_id', user.id);
    if (jobId) q = q.eq('id', jobId);
    if (source) q = q.eq('source', source);
    if (period) q = q.eq('period', period);
    const { data: jobs, error } = await q.order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const job = jobs?.[0] || null;
    if (!job) return new Response(JSON.stringify({ job: null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    let download_url: string | null = null;
    if (job.file_path) {
      const { data: signed } = await admin.storage
        .from('raw-extractions')
        .createSignedUrl(job.file_path, 60 * 60 * 24);
      download_url = signed?.signedUrl || null;
    }

    // Auto-resume: si el job lleva > 60s sin avanzar, dispara la función con resume.
    if (job.status === 'running' || job.status === 'pending') {
      const ageMs = Date.now() - new Date(job.updated_at).getTime();
      if (ageMs > 60_000) {
        const fn = job.source === 'meli' ? 'raw-extract-meli' : 'raw-extract-bsale';
        const resumeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/${fn}`;
        fetch(resumeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-resume': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
          },
          body: JSON.stringify({ job_id: job.id, resume: true }),
        }).catch((e) => console.error('auto-resume failed', e));
      }
    }

    return new Response(JSON.stringify({ job, download_url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Unknown' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});