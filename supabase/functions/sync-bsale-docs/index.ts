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

// Map Bsale document type to our enum - STRICT: returns null if not valid SII code
function mapBsaleDocType(codeSii: number | undefined): 'boleta' | 'factura' | 'nota_credito' | 'nota_debito' | 'factura_exenta' | null {
  if (codeSii === 33) return 'factura';
  if (codeSii === 34) return 'factura_exenta';
  if (codeSii === 39 || codeSii === 41) return 'boleta';
  if (codeSii === 61) return 'nota_credito';
  if (codeSii === 56) return 'nota_debito';
  
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
  const codeSii = doc.document_type?.codeSii;
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

  const emissionDate = doc.emissionDate 
    ? new Date(doc.emissionDate * 1000).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

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
    const codeSii = doc.document_type?.codeSii;
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
      is_resync = false,
      resync_batch = null,
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
    const emissionDateFrom = date_from 
      ? Number(date_from) 
      : now - (days_back * 24 * 60 * 60);
    const emissionDateTo = now;

    console.log(`Date range: ${new Date(emissionDateFrom * 1000).toISOString()} to ${new Date(emissionDateTo * 1000).toISOString()}`);

    // Use api.bsale.cl (same host the webhook uses successfully).
    // api.bsale.io works too but some accounts return count:0 with codesii lists.
    const BSALE_API_URL = 'https://api.bsale.cl';
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    let pageCount = 0;
    
    let totalFetched = 0;
    let totalValid = 0;
    let totalIgnored = 0;
    let totalUpserted = 0;
    let totalErrors = 0;
    const docTypeCounts: Record<string, number> = {};

    // Process page by page - upsert immediately, don't accumulate
    while (hasMore && pageCount < max_pages) {
      // IMPORTANT: do NOT send `codesii` here. Bsale returns count:0 silently
      // when given a comma-separated list for some accounts. We filter by SII
      // code post-fetch in filterValidTributaryDocs().
      const url = new URL(`${BSALE_API_URL}/v1/documents.json`);
      url.searchParams.set('emissiondaterange', `[${emissionDateFrom},${emissionDateTo}]`);
      url.searchParams.set('expand', '[details,client,document_type,references,coin]');
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());

      console.log(`Page ${pageCount + 1}: ${url.toString()}`);

      const bsaleResponse = await fetch(url.toString(), {
        headers: {
          'access_token': bsaleToken,
          'Content-Type': 'application/json',
        },
      });

      if (!bsaleResponse.ok) {
        const errorText = await bsaleResponse.text();
        console.error('Bsale API error:', bsaleResponse.status, errorText);
        throw new Error(`Bsale API error: ${bsaleResponse.status}`);
      }

      const bsaleData = await bsaleResponse.json();
      const docs = bsaleData.items || [];
      
      console.log(`Page ${pageCount + 1}: Fetched ${docs.length} documents (offset ${offset}, total: ${bsaleData.count || '?'})`);
      
      if (docs.length === 0) {
        hasMore = false;
      } else {
        totalFetched += docs.length;
        
        // POST-FETCH FILTER: Security layer to validate SII codes
        const { valid: validDocs, ignored: pageIgnored } = filterValidTributaryDocs(docs);
        totalIgnored += pageIgnored;
        totalValid += validDocs.length;
        
        console.log(`Page ${pageCount + 1}: Filtered ${validDocs.length} valid docs (ignored ${pageIgnored})`);

        // Transform docs to our schema (references already included via expand=[...,references])
        const taxDocsToUpsert = validDocs
          .map((doc: any) => {
            const transformed = transformBsaleDoc(doc, user.id, batchId);
            if (transformed) {
              docTypeCounts[transformed.document_type] = (docTypeCounts[transformed.document_type] || 0) + 1;
              // Detect channel using all available signals (references, coin, client note, details)
              const detectedChannel = detectChannelFromDoc(doc);
              const referenceReason = doc.references?.items?.[0]?.reason || null;
              const coinName = doc.coin?.name || null;
              (transformed.raw_data as any).reference_reason = referenceReason;
              (transformed.raw_data as any).payment_method_name = coinName;
              return {
                ...transformed,
                sales_channel: 'MARKETPLACE',
                detected_channel: detectedChannel,
              };
            }
            return null;
          })
          .filter((doc: any) => doc !== null);

        if (taxDocsToUpsert.length > 0) {
          const { data: upserted, error: upsertError } = await supabaseClient
            .from('tax_documents')
            .upsert(taxDocsToUpsert, {
              onConflict: 'user_id,external_system,external_id',
              ignoreDuplicates: false
            })
            .select('id, detected_channel');

          if (upsertError) {
            console.error(`Page ${pageCount + 1} upsert error:`, upsertError.message);
            totalErrors += taxDocsToUpsert.length;
          } else {
            totalUpserted += (upserted?.length || 0);
            const meliCount = upserted?.filter((d: any) => d.detected_channel === 'meli').length || 0;
            console.log(`Page ${pageCount + 1}: Upserted ${upserted?.length || 0} documents (${meliCount} meli detected)`);
          }
        }

        offset += limit;
        pageCount++;
        
        if (bsaleData.count && totalFetched >= bsaleData.count) {
          hasMore = false;
        }
      }

      // Rate limit: 150ms delay (~6.6 req/seg, safe under Bsale's 8 req/seg)
      if (hasMore) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    console.log('\n=== SYNC SUMMARY ===');
    console.log(`Pages processed: ${pageCount}`);
    console.log(`Total fetched: ${totalFetched}`);
    console.log(`Total valid: ${totalValid}`);
    console.log(`Total ignored: ${totalIgnored}`);
    console.log(`Total upserted: ${totalUpserted}`);
    console.log(`Errors: ${totalErrors}`);
    console.log('By type:', docTypeCounts);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Sincronización de documentos Bsale completada',
        resync_batch: batchId,
        summary: {
          pages_processed: pageCount,
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
