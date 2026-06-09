import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Normalize RUT: remove dots, dashes, and uppercase
function normalizeRut(rut: string | null | undefined): string | null {
  if (!rut) return null;
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
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

// Detect channel from reference reason
function detectChannelFromReference(reason: string | null): string | null {
  if (!reason) return null;
  const upper = reason.toUpperCase();
  if (upper.includes('MERCADO LIBRE') || upper.includes('MERCADOLIBRE')) return 'meli';
  if (upper.includes('FALABELLA')) return 'falabella';
  if (upper.includes('AMAZON')) return 'amazon';
  if (upper.includes('SHOPIFY')) return 'shopify';
  return null;
}

// Classify sales channel based on reference reason and order match
function classifySalesChannel(referenceReason: string | null, hasMatchingOrder: boolean): string {
  const channel = detectChannelFromReference(referenceReason);
  if (channel) return 'MARKETPLACE';
  if (hasMatchingOrder) return 'MARKETPLACE';
  return 'B2B';
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

  const clientTaxId = normalizeRut(doc.client?.code);
  
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
      days_back = 120,
      max_pages = 150,
      date_from = null,
      is_resync = false,
      resync_batch = null
    } = body;

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

    const BSALE_API_URL = 'https://api.bsale.io';
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
      const url = new URL(`${BSALE_API_URL}/v1/documents.json`);
      url.searchParams.set('emissiondaterange', `[${emissionDateFrom},${emissionDateTo}]`);
      // FILTER: Only fetch tributary documents (Libro de Ventas)
      url.searchParams.set('codesii', '33,34,39,41,61,56');
      // EXPAND: Include references for order ID extraction
      url.searchParams.set('expand', '[details,client,document_type,references]');
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

        // Fetch references for each document (for channel detection)
        const docsWithReferences = await Promise.all(
          validDocs.map(async (doc: any, idx: number) => {
            const refHref = doc.references?.href;
            let referenceItems: any[] = [];
            let referenceReason: string | null = null;
            
            if (refHref) {
              try {
                // Rate limit: small delay between reference fetches
                if (idx > 0) {
                  await new Promise(r => setTimeout(r, 50));
                }
                
                const refResponse = await fetch(refHref, {
                  headers: { 'access_token': bsaleToken }
                });
                
                if (refResponse.ok) {
                  const refData = await refResponse.json();
                  referenceItems = refData.items || [];
                  referenceReason = referenceItems[0]?.reason || null;
                }
              } catch (e) {
                console.warn(`Failed to fetch references for doc ${doc.id}:`, e);
              }
            }
            
            return {
              ...doc,
              references: {
                ...doc.references,
                items: referenceItems,
              },
              _referenceReason: referenceReason,
            };
          })
        );
        
        // Transform docs to our schema
        const taxDocsToUpsert = docsWithReferences
          .map((doc: any) => {
            const transformed = transformBsaleDoc(doc, user.id, batchId);
            if (transformed) {
              const docType = transformed.document_type;
              docTypeCounts[docType] = (docTypeCounts[docType] || 0) + 1;
              // Add reference data to raw_data
              (transformed.raw_data as any).reference_items = doc.references?.items || [];
              (transformed.raw_data as any).reference_reason = doc._referenceReason;
            }
            return { transformed, referenceReason: doc._referenceReason };
          })
          .filter((item: any) => item.transformed !== null);

        if (taxDocsToUpsert.length > 0) {
          // Classify each document as MARKETPLACE or B2B
          const classifiedDocs = await Promise.all(taxDocsToUpsert.map(async ({ transformed: doc, referenceReason }: any) => {
            // Check reference reason first (primary criterion)
            const detectedChannel = detectChannelFromReference(referenceReason);
            
            // If no channel from reference, check RUT in orders (secondary criterion)
            let hasMatchingOrder = false;
            if (!detectedChannel && doc.client_tax_id) {
              const normalizedRut = doc.client_tax_id.toUpperCase();
              const { data: matchingOrder } = await supabaseClient
                .from('orders')
                .select('id')
                .filter('customer_tax_id', 'ilike', `%${normalizedRut.replace(/[^0-9K]/gi, '')}%`)
                .limit(1);
              hasMatchingOrder = !!(matchingOrder && matchingOrder.length > 0);
            }
            
            return {
              ...doc,
              sales_channel: classifySalesChannel(referenceReason, hasMatchingOrder),
              detected_channel: detectedChannel,
            };
          }));

          // Batch upsert this page immediately
          const { data: upserted, error: upsertError } = await supabaseClient
            .from('tax_documents')
            .upsert(classifiedDocs, {
              onConflict: 'user_id,external_system,external_id',
              ignoreDuplicates: false
            })
            .select('id, sales_channel, detected_channel');

          if (upsertError) {
            console.error(`Page ${pageCount + 1} upsert error:`, upsertError.message);
            totalErrors += taxDocsToUpsert.length;
          } else {
            totalUpserted += (upserted?.length || 0);
            const marketplaceCount = upserted?.filter(d => d.sales_channel === 'MARKETPLACE').length || 0;
            const b2bCount = upserted?.filter(d => d.sales_channel === 'B2B').length || 0;
            const meliCount = upserted?.filter(d => d.detected_channel === 'meli').length || 0;
            console.log(`Page ${pageCount + 1}: Upserted ${upserted?.length || 0} documents (${marketplaceCount} marketplace [${meliCount} meli], ${b2bCount} B2B)`);
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
