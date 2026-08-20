import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveUserId } from '../_shared/auth.ts';
import {
  VALID_SII_CODES,
  buildTaxDocumentPayload,
  filterValidTributaryDocs,
  normalizeCodeSii,
} from '../_shared/bsale-document.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// VALID_SII_CODES (módulo compartido) MUST stay sorted ascending: el cursor de reanudación salta los
// códigos con `codeSii < start_code_sii`, así que un orden no ascendente hace
// que al reanudar se reprocese un código anterior en loop infinito.
const FETCH_TIMEOUT_MS = 20_000;
const TIME_BUDGET_MS = 85_000;
const MAX_PAGES_PER_INVOCATION = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Bsale expone las formas de pago reales del documento vía `payments`, y cada
// pago referencia un `payment_type` (a veces sólo con id/href). Cargamos el
// catálogo de payment types UNA vez por invocación para resolver nombres sin
// hacer N llamadas por documento.
async function loadPaymentTypeNames(apiUrl: string, token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (let offset = 0; offset < 500; offset += 50) {
      const u = new URL(`${apiUrl}/v1/payment_types.json`);
      u.searchParams.set('limit', '50');
      u.searchParams.set('offset', String(offset));
      const r = await fetchBsalePage(u, token);
      if (!r.ok) break;
      const items: any[] = r.data?.items || [];
      for (const it of items) {
        if (it?.id != null && it?.name) map.set(String(it.id), String(it.name));
      }
      if (items.length < 50) break;
    }
  } catch (e) {
    console.warn('No se pudo cargar payment_types:', (e as any)?.message);
  }
  return map;
}

async function fetchBsalePage(url: URL, bsaleToken: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'access_token': bsaleToken, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      const rawText = await response.text().catch(() => '');

      if (!response.ok) {
        const error = `Bsale API ${response.status}`;
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        if (retryable && attempt < 2) {
          console.warn(`${error}, retry ${attempt}/2`);
          await sleep(500 * attempt);
          continue;
        }
        return { ok: false as const, error, detail: rawText.slice(0, 200) };
      }

      if (!rawText) {
        return { ok: true as const, data: {} };
      }

      try {
        return { ok: true as const, data: JSON.parse(rawText) };
      } catch {
        return {
          ok: false as const,
          error: 'Bsale API invalid JSON',
          detail: rawText.slice(0, 200),
        };
      }
    } catch (e: any) {
      const error = e?.name === 'AbortError'
        ? `Bsale fetch timeout (${FETCH_TIMEOUT_MS}ms)`
        : `fetch failed: ${e?.message || 'network'}`;

      if (attempt < 2) {
        console.warn(`${error}, retry ${attempt}/2`);
        await sleep(500 * attempt);
        continue;
      }

      return { ok: false as const, error, detail: '' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { ok: false as const, error: 'Bsale fetch failed', detail: '' };
}

// Resuelve el documento ORIGINAL que anula una Nota de Crédito.
// Las references de Bsale en una NC llevan el folio del documento original;
// lo cruzamos contra nuestros propios tax_documents (mismo usuario) para setear
// original_tax_document_id. Los números de orden MELI que también vienen en
// references no matchean ningún document_number, así que se filtran solos.
async function resolveOriginalDocId(
  supabase: any, userId: string, doc: any
): Promise<string | null> {
  const refs = doc.references?.items || [];
  const numbers = refs
    .map((r: any) => (r.number != null ? String(r.number) : null))
    .filter(Boolean) as string[];
  if (numbers.length === 0) return null;
  const { data } = await supabase
    .from('tax_documents')
    .select('id, client_tax_id')
    .eq('user_id', userId)
    .eq('external_system', 'bsale')
    .in('document_number', numbers)
    .in('document_type', ['boleta', 'factura', 'factura_exenta']);
  if (!data || data.length === 0) return null;
  return data[0].id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Use service role for batch operations
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Get request body for optional filters
    const body = await req.json().catch(() => ({}));
    const {
      days_back = 90,
      max_pages = 150,
      date_from = null,
      date_to = null,
      is_resync = false,
      resync_batch = null,
      start_code_sii = null,
      start_offset = 0,
      account_id: accountIdParam = null,
      reclassify_b2b = false,  // If true: fix existing B2B docs to MARKETPLACE (no new sync)
      link_credit_notes = false, // If true: vincular NCs existentes a su doc original (sin API Bsale)
      user_id: userIdParam = null,
    } = body;

    // Validate user from auth header (or service-role + user_id for cron calls)
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

    console.log('=== SYNC BSALE DOCS START ===');
    console.log('User ID:', user.id);

    // MODE: reclassify_b2b — fix existing docs that were wrongly saved as B2B
    if (reclassify_b2b) {
      console.log('=== RECLASSIFY B2B DOCS MODE ===');
      const { data: fixed, error: fixErr } = await supabaseClient
        .from('tax_documents')
        .update({ sales_channel: 'MARKETPLACE' })
        .eq('user_id', user.id)
        .eq('sales_channel', 'B2B')
        .select('id');
      if (fixErr) {
        console.error('Reclassify error:', fixErr);
        return new Response(JSON.stringify({ error: fixErr.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const count = fixed?.length || 0;
      console.log(`Reclassified ${count} B2B docs to MARKETPLACE`);
      return new Response(JSON.stringify({ success: true, reclassified: count }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // MODE: link_credit_notes — vincular NCs históricas a su documento original
    // usando las references YA guardadas en raw_data (sin llamar a la API de Bsale).
    // Idempotente: solo toca las que tienen original_tax_document_id NULL.
    if (link_credit_notes) {
      console.log('=== LINK CREDIT NOTES MODE ===');
      const startedAtLink = Date.now();
      let checked = 0, linked = 0, partialLink = false, lastId = '';
      const PAGE = 300;
      for (;;) {
        if (Date.now() - startedAtLink > TIME_BUDGET_MS) { partialLink = true; break; }
        const { data: ncs, error: ncErr } = await supabaseClient
          .from('tax_documents')
          .select('id, client_tax_id, raw_data')
          .eq('user_id', user.id)
          .eq('document_type', 'nota_credito')
          .is('original_tax_document_id', null)
          .gt('id', lastId)
          .order('id', { ascending: true })
          .limit(PAGE);
        if (ncErr) {
          return new Response(JSON.stringify({ error: ncErr.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!ncs || ncs.length === 0) break;
        for (const nc of ncs) {
          lastId = nc.id;
          checked++;
          const refs = (nc.raw_data as any)?.references?.items || [];
          const numbers = refs
            .map((r: any) => (r.number != null ? String(r.number) : null))
            .filter(Boolean) as string[];
          if (numbers.length === 0) continue;
          const { data: origs } = await supabaseClient
            .from('tax_documents')
            .select('id, client_tax_id')
            .eq('user_id', user.id)
            .eq('external_system', 'bsale')
            .in('document_number', numbers)
            .in('document_type', ['boleta', 'factura', 'factura_exenta']);
          if (!origs || origs.length === 0) continue;
          // Preferir mismo RUT de cliente; si no, el primero.
          const pick = origs.find((o: any) => o.client_tax_id && o.client_tax_id === nc.client_tax_id) || origs[0];
          const { error: upErr } = await supabaseClient
            .from('tax_documents')
            .update({ original_tax_document_id: pick.id })
            .eq('id', nc.id);
          if (!upErr) linked++;
        }
        if (ncs.length < PAGE) break;
      }
      console.log(`Link credit notes: checked ${checked}, linked ${linked}, partial ${partialLink}`);
      return new Response(
        JSON.stringify({ success: true, mode: 'link_credit_notes', checked, linked, partial: partialLink }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validación: resync requiere date_from obligatorio
    if (is_resync && !date_from) {
      return new Response(
        JSON.stringify({ error: 'date_from required for resync' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const batchId = resync_batch || crypto.randomUUID();

    // Get the requested Bsale connection. Legacy callers that omit account_id
    // keep the previous behavior (the user's single connected Bsale account).
    let bsaleAccountQuery = supabaseClient
      .from('bsale_accounts')
      .select('id, access_token, cpn_id, client_name, status')
      .eq('user_id', user.id)
      .eq('status', 'connected');
    if (accountIdParam) bsaleAccountQuery = bsaleAccountQuery.eq('id', accountIdParam);
    const { data: bsaleAccount, error: bsaleError } = await bsaleAccountQuery.maybeSingle();

    if (bsaleError || !bsaleAccount) {
      console.error('Bsale account not found or not connected:', bsaleError);
      return new Response(
        JSON.stringify({
          error: 'Bsale no conectado',
          message: 'Por favor conecta tu cuenta Bsale en Configuración'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const bsaleToken = bsaleAccount.access_token;
    console.log(`Bsale account found: ${bsaleAccount.client_name} (cpn_id: ${bsaleAccount.cpn_id})`);

    // Calculate date range
    const now = Math.floor(Date.now() / 1000);
    const emissionDateFrom = date_from != null
      ? Number(date_from)
      : now - (days_back * 24 * 60 * 60);
    const emissionDateTo = date_to != null ? Number(date_to) : now;

    if (!Number.isFinite(emissionDateFrom) || !Number.isFinite(emissionDateTo) || emissionDateFrom >= emissionDateTo) {
      return new Response(
        JSON.stringify({ error: 'Rango de fechas inválido (date_from debe ser menor a date_to, ambos en unix seconds)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Date range: ${new Date(emissionDateFrom * 1000).toISOString()} to ${new Date(emissionDateTo * 1000).toISOString()}`);

    // Use api.bsale.cl (same host the webhook uses successfully).
    const BSALE_API_URL = 'https://api.bsale.cl';
    const limit = 50;

    let totalFetched = 0;
    let totalValid = 0;
    let totalIgnored = 0;
    let totalUpserted = 0;
    let totalErrors = 0;
    let pageCount = 0;
    let timedOut = false;
    let apiError: string | null = null;
    const docTypeCounts: Record<string, number> = {};

    const startedAt = Date.now();
    const normalizedStartCode = normalizeCodeSii(start_code_sii);
    const normalizedStartOffset = Number.isFinite(Number(start_offset)) && Number(start_offset) >= 0
      ? Number(start_offset)
      : 0;
    const maxPagesThisRun = Math.min(Number(max_pages) || MAX_PAGES_PER_INVOCATION, MAX_PAGES_PER_INVOCATION);
    let nextCursor: { code_sii: number; offset: number } | null = null;
    let pagesThisRun = 0;

    // Catálogo de formas de pago (id → nombre), una sola vez por invocación.
    const paymentTypeNames = await loadPaymentTypeNames(BSALE_API_URL, bsaleToken);
    console.log(`payment_types cargados: ${paymentTypeNames.size}`);

    // Total disponible (suma del `count` de Bsale por cada código SII), para
    // que el frontend pueda mostrar "X de N". Solo se calcula en arranque
    // fresco (sin cursor); en reanudaciones el front ya lo tiene en el checkpoint.
    let totalAvailable: number | null = null;
    if (normalizedStartCode === null) {
      totalAvailable = 0;
      for (const code of VALID_SII_CODES) {
        const u = new URL(`${BSALE_API_URL}/v1/documents.json`);
        u.searchParams.set('emissiondaterange', `[${emissionDateFrom},${emissionDateTo}]`);
        u.searchParams.set('codesii', String(code));
        u.searchParams.set('limit', '1');
        u.searchParams.set('offset', '0');
        const r = await fetchBsalePage(u, bsaleToken);
        if (r.ok) totalAvailable += (r.data?.count ?? 0);
      }
      console.log(`Total disponible (todos los códigos): ${totalAvailable}`);
    }

    // Query per SII code individually. This avoids dragging the full universe
    // (guías de despacho + notas de venta) just to filter them out client-side,
    // which is what was driving the 150s idle timeout.
    outer: for (let codeIndex = 0; codeIndex < VALID_SII_CODES.length; codeIndex++) {
      const codeSii = VALID_SII_CODES[codeIndex];
      if (normalizedStartCode !== null && codeSii < normalizedStartCode) continue;

      let offset = codeSii === normalizedStartCode ? normalizedStartOffset : 0;
      let hasMore = true;
      let codeApiError: string | null = null;

      while (hasMore && pageCount < max_pages) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          console.log(`⏱️ Time budget exceeded at codeSii=${codeSii}, stopping`);
          timedOut = true;
          nextCursor = { code_sii: codeSii, offset };
          break outer;
        }

        if (pagesThisRun >= maxPagesThisRun) {
          console.log(`⏭️ Invocation page cap reached at codeSii=${codeSii}, stopping`);
          timedOut = true;
          nextCursor = { code_sii: codeSii, offset };
          break outer;
        }

        const url = new URL(`${BSALE_API_URL}/v1/documents.json`);
        url.searchParams.set('emissiondaterange', `[${emissionDateFrom},${emissionDateTo}]`);
        url.searchParams.set('codesii', String(codeSii));
        url.searchParams.set('expand', '[details,client,document_type,references,coin,payments]');
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('offset', String(offset));

        console.log(`[codeSii=${codeSii}] page ${pageCount + 1}: offset=${offset}`);

        const pageResult = await fetchBsalePage(url, bsaleToken);
        if (!pageResult.ok) {
          codeApiError = pageResult.error;
          console.error(`[codeSii=${codeSii}] ${codeApiError}: ${pageResult.detail}`);
          nextCursor = { code_sii: codeSii, offset };
          break;
        }

        const bsaleData = pageResult.data || {};
        const docs: any[] = bsaleData.items || [];
        const totalForCode = bsaleData.count ?? 0;

        console.log(`[codeSii=${codeSii}] fetched ${docs.length} (offset ${offset}/${totalForCode})`);

        if (docs.length === 0) {
          hasMore = false;
          break;
        }

        totalFetched += docs.length;

        // Defense in depth: still filter post-fetch in case Bsale returns
        // mixed types for some accounts.
        const { valid: validDocs, ignored: pageIgnored } = filterValidTributaryDocs(docs);
        totalIgnored += pageIgnored;
        totalValid += validDocs.length;

        const taxDocsToUpsert: any[] = [];
        for (const doc of validDocs) {
          try {
            // Normalizador canónico compartido con `bsale-webhook`.
            // Forma de pago REAL desde Bsale `payments` → `payment_type`.
            // `coin.name` es la moneda ("Peso Chileno"), NO la forma de pago.
            const transformed = buildTaxDocumentPayload(doc, {
              userId: user.id,
              paymentTypeNames,
              batchId,
            });
            if (!transformed) continue;
            docTypeCounts[transformed.document_type] = (docTypeCounts[transformed.document_type] || 0) + 1;
            // NC → documento original: resolver el enlace al sincronizar (las
            // boletas/facturas del mismo período ya se procesaron antes, porque
            // codeSii 61 va último en VALID_SII_CODES).
            let originalDocId: string | null = null;
            if (transformed.document_type === 'nota_credito') {
              originalDocId = await resolveOriginalDocId(supabaseClient, user.id, doc);
            }
            taxDocsToUpsert.push({
              ...transformed,
              ...(originalDocId ? { original_tax_document_id: originalDocId } : {}),
            });
          } catch (error) {
            console.error(`❌ Error processing doc ${doc.id}:`, error);
            totalErrors++;
          }
        }

        if (taxDocsToUpsert.length > 0) {
          const { error: upsertError } = await supabaseClient
            .from('tax_documents')
            .upsert(taxDocsToUpsert, {
              onConflict: 'user_id,external_system,external_id',
              ignoreDuplicates: false,
            });

          if (upsertError) {
            console.error(`[codeSii=${codeSii}] upsert error:`, upsertError.message);
            totalErrors += taxDocsToUpsert.length;
          } else {
            totalUpserted += taxDocsToUpsert.length;
          }
        }

        offset += limit;
        pageCount++;
        pagesThisRun++;
        if (totalForCode && offset >= totalForCode) hasMore = false;
        if (hasMore) {
          nextCursor = { code_sii: codeSii, offset };
          await sleep(150);
        } else if (codeIndex + 1 < VALID_SII_CODES.length) {
          nextCursor = { code_sii: VALID_SII_CODES[codeIndex + 1], offset: 0 };
        } else {
          nextCursor = null;
        }
      }

      if (codeApiError && !apiError) apiError = codeApiError;
    }

    console.log('\n=== SYNC SUMMARY ===');
    console.log(`Pages processed: ${pageCount}`);
    console.log(`Total fetched: ${totalFetched}`);
    console.log(`Total valid: ${totalValid}`);
    console.log(`Total ignored: ${totalIgnored}`);
    console.log(`Total upserted: ${totalUpserted}`);
    console.log(`Errors: ${totalErrors}`);
    console.log('By type:', docTypeCounts);
    if (timedOut) console.log('⏱️ Stopped early due to time budget');
    if (apiError) console.log(`⚠️ Stopped due to Bsale API error: ${apiError}`);

    const partial = timedOut || !!apiError || !!nextCursor;

    return new Response(
      JSON.stringify({
        success: true,
        message: partial
          ? 'Sincronización parcial de Bsale (volvé a correrla para continuar)'
          : 'Sincronización de documentos Bsale completada',
        partial,
        account_id: bsaleAccount.id,
        ...(apiError ? { error_detail: apiError } : {}),
        resync_batch: batchId,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        summary: {
          pages_processed: pageCount,
          pages_processed_this_run: pagesThisRun,
          total_fetched: totalFetched,
          total_valid: totalValid,
          total_ignored: totalIgnored,
          total_upserted: totalUpserted,
          total_available: totalAvailable,
          errors: totalErrors,
          by_type: docTypeCounts,
          date_range: {
            from: new Date(emissionDateFrom * 1000).toISOString(),
            to: new Date(emissionDateTo * 1000).toISOString()
          }
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error syncing Bsale documents:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
