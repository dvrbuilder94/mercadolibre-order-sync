import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Split RUT into body + DV. Body = digits only, DV = last char (0-9 or K).
function splitRut(rut: string | null | undefined): { body: string | null; dv: string | null } {
  if (!rut) return { body: null, dv: null };
  const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2) return { body: null, dv: null };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
}

// Valid SII codes for tributary documents
const VALID_SII_CODES = [33, 34, 39, 41, 61, 56];
const FETCH_TIMEOUT_MS = 20_000;
const TIME_BUDGET_MS = 85_000;
const MAX_PAGES_PER_INVOCATION = 20;

function normalizeCodeSii(codeSii: string | number | null | undefined): number | null {
  if (codeSii === null || codeSii === undefined || codeSii === '') return null;
  const normalized = Number(codeSii);
  return Number.isFinite(normalized) ? normalized : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Map Bsale document type to our enum - STRICT: returns null if not valid SII code
function mapBsaleDocType(codeSii: number | undefined): 'boleta' | 'factura' | 'nota_credito' | 'nota_debito' | 'factura_exenta' | null {
  const normalized = normalizeCodeSii(codeSii);
  if (normalized === 33) return 'factura';
  if (normalized === 34) return 'factura_exenta';
  if (normalized === 39 || normalized === 41) return 'boleta';
  if (normalized === 61) return 'nota_credito';
  if (normalized === 56) return 'nota_debito';
  
  // STRICT: No fallback - only valid codeSii accepted
  return null;
}

// Detect channel from any text string (reference reason, payment name, etc.)
function detectChannelFromText(text: string | null): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  // MercadoLibre / MercadoPago (same marketplace)
  if (upper.includes('MERCADO LIBRE') || upper.includes('MERCADOLIBRE') ||
      upper.includes('MERCADO PAGO') || upper.includes('MERCADOPAGO') ||
      upper.includes('ML ') || upper.includes(' ML') || upper === 'ML') return 'meli';
  // Falabella / CMR
  if (upper.includes('FALABELLA') || upper.includes('CMR')) return 'falabella';
  // Paris / Cencosud
  if (upper.includes('PARIS') || upper.includes('CENCOSUD') || upper.includes('PARIS.CL')) return 'paris';
  // Ripley
  if (upper.includes('RIPLEY')) return 'ripley';
  // Amazon
  if (upper.includes('AMAZON')) return 'amazon';
  // Shopify
  if (upper.includes('SHOPIFY')) return 'shopify';
  // Linio / Allegro
  if (upper.includes('LINIO')) return 'linio';
  // Rappi
  if (upper.includes('RAPPI')) return 'rappi';
  // Walmart / Líder
  if (upper.includes('WALMART') || upper.includes('LIDER') || upper.includes('LÍDER')) return 'walmart';
  return null;
}

// Legacy alias kept for compatibility
const detectChannelFromReference = detectChannelFromText;

// Detect channel from a Bsale document using all available signals
function detectChannelFromDoc(doc: any): string | null {
  // 1. Check all references (not just first)
  if (doc.references?.items?.length > 0) {
    for (const ref of doc.references.items) {
      const hit = detectChannelFromText(ref.reason) || detectChannelFromText(ref.number?.toString());
      if (hit) return hit;
    }
  }
  // 2. Check coin/payment method name (e.g. "Mercado Pago")
  if (doc.coin?.name) {
    const hit = detectChannelFromText(doc.coin.name);
    if (hit) return hit;
  }
  // 3. Check client note
  if (doc.client?.note) {
    const hit = detectChannelFromText(doc.client.note);
    if (hit) return hit;
  }
  // 4. Check detail comments
  if (doc.details?.items?.length > 0) {
    for (const detail of doc.details.items) {
      const hit = detectChannelFromText(detail.comment);
      if (hit) return hit;
    }
  }
  return null;
}

// Classify sales channel based on reference reason and order match.
// Default is MARKETPLACE — docs without a matching order are likely mis-timed syncs,
// not genuine B2B wholesale. auto-reconcile will leave unmatched docs unlinked.
function classifySalesChannel(referenceReason: string | null, hasMatchingOrder: boolean): string {
  const channel = detectChannelFromReference(referenceReason);
  if (channel) return 'MARKETPLACE';
  if (hasMatchingOrder) return 'MARKETPLACE';
  return 'MARKETPLACE'; // Default: don't exclude from reconciliation engine
}

// Extract external order ID from various fields
function extractExternalOrderId(doc: any): string | null {
  // Pattern: 10+ digit number (typical ML order ID format)
  const orderIdPattern = /(\d{10,})/;
  
  // 1. Search in client.note
  if (doc.client?.note) {
    const match = doc.client.note.match(orderIdPattern);
    if (match) return match[1];
  }
  
  // 2. Search in references (expanded)
  if (doc.references?.items?.length > 0) {
    for (const ref of doc.references.items) {
      const searchText = `${ref.reason || ''} ${ref.number || ''}`;
      const match = searchText.match(orderIdPattern);
      if (match) return match[1];
    }
  }
  
  // 3. Search in details comments
  if (doc.details?.items?.length > 0) {
    for (const detail of doc.details.items) {
      if (detail.comment) {
        const match = detail.comment.match(orderIdPattern);
        if (match) return match[1];
      }
    }
  }
  
  return null;
}

// Transform a Bsale document to our tax_documents schema
function transformBsaleDoc(doc: any, userId: string, batchId: string) {
  const codeSii = normalizeCodeSii(doc.document_type?.codeSii);
  const docType = mapBsaleDocType(codeSii);
  
  // STRICT: Skip if not a valid tributary document
  if (!docType) {
    return null;
  }
  
  const clientName = doc.client?.firstName && doc.client?.lastName 
    ? `${doc.client.firstName} ${doc.client.lastName}`.trim()
    : doc.client?.company || doc.client?.activity || 'Cliente';

  const { body: clientTaxId, dv: clientTaxIdDv } = splitRut(doc.client?.code);
  
  const netAmount = parseFloat(doc.netAmount || 0);
  const taxAmount = parseFloat(doc.taxAmount || 0);
  const totalAmount = parseFloat(doc.totalAmount || 0) || (netAmount + taxAmount);

  // Use Chile's calendar date, not UTC — emissionDate near midnight shifts
  // to the next/previous UTC day and lands in the wrong month otherwise.
  const emissionDate = doc.emissionDate
    ? new Date(doc.emissionDate * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' })
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });

  // Bsale: state=0 is ACTIVE/issued, state=1 is VOIDED
  const docStatus = doc.state === 0 ? 'issued' : 'voided';

  // Extract external order ID for auto-linking
  const externalOrderId = extractExternalOrderId(doc);

  return {
    user_id: userId,
    document_type: docType,
    document_number: doc.number?.toString() || doc.id.toString(),
    document_date: emissionDate,
    net_amount: netAmount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    client_name: clientName,
    client_tax_id: clientTaxId,
    client_tax_id_dv: clientTaxIdDv,
    external_system: 'bsale',
    external_id: doc.id.toString(),
    external_order_id: externalOrderId,
    external_url: doc.urlPublicView || null,
    erp: 'BSALE',
    status: docStatus,
    resync_batch: batchId,
    raw_data: {
      id: doc.id,
      number: doc.number,
      emissionDate: doc.emissionDate,
      codeSii: codeSii,
      typeName: doc.document_type?.name,
      clientNote: doc.client?.note,
      references: doc.references,
      coin: doc.coin || null,
      office: doc.office,
      external_order_id: externalOrderId,
      details: doc.details?.items?.map((d: any) => ({
        description: d.comment,
        quantity: d.quantity,
        netAmount: d.netAmount,
      })) || [],
    },
  };
}

// Filter documents to only valid tributary types (post-fetch security)
function filterValidTributaryDocs(docs: any[]): { valid: any[], ignored: number } {
  const validDocs = docs.filter((doc: any) => {
    const codeSii = normalizeCodeSii(doc.document_type?.codeSii);
    const typeName = (doc.document_type?.name || '').toUpperCase();
    
    // Explicitly exclude dispatch guides and sales notes
    if (codeSii === 52) return false; // Guía de Despacho
    if (!codeSii && typeName.includes('NOTA VENTA')) return false;
    if (!codeSii && typeName.includes('GUÍA')) return false;
    
    // Only accept valid SII codes
    return codeSii && VALID_SII_CODES.includes(codeSii);
  });
  
  return {
    valid: validDocs,
    ignored: docs.length - validDocs.length
  };
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

    // Validate user from auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await userClient.auth.getUser();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('=== SYNC BSALE DOCS START ===');
    console.log('User ID:', user.id);

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
      reclassify_b2b = false  // If true: fix existing B2B docs to MARKETPLACE (no new sync)
    } = body;

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

    // Validación: resync requiere date_from obligatorio
    if (is_resync && !date_from) {
      return new Response(
        JSON.stringify({ error: 'date_from required for resync' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const batchId = resync_batch || crypto.randomUUID();

    // Get user's Bsale account and token
    const { data: bsaleAccount, error: bsaleError } = await supabaseClient
      .from('bsale_accounts')
      .select('id, access_token, cpn_id, client_name, status')
      .eq('user_id', user.id)
      .eq('status', 'connected')
      .maybeSingle();

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
        url.searchParams.set('expand', '[details,client,document_type,references,coin]');
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
            const transformed = transformBsaleDoc(doc, user.id, batchId);
            if (!transformed) continue;
            docTypeCounts[transformed.document_type] = (docTypeCounts[transformed.document_type] || 0) + 1;
            const detectedChannel = detectChannelFromDoc(doc);
            const referenceReason = doc.references?.items?.[0]?.reason || null;
            const coinName = doc.coin?.name || null;
            (transformed.raw_data as any).reference_reason = referenceReason;
            (transformed.raw_data as any).payment_method_name = coinName;
            taxDocsToUpsert.push({
              ...transformed,
              sales_channel: 'MARKETPLACE',
              detected_channel: detectedChannel,
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
