import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { HttpInputError, readJsonBody } from '../_shared/http.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface BsaleWebhookPayload {
  cpnId: string | number
  topic: string
  resourceId: number
  action: string
}

interface BsaleAccount {
  id: string
  user_id: string
  access_token: string
  cpn_id: string
}

// Split RUT into body + DV. Body = digits only, DV = last char (0-9 or K).
function splitRut(rut: string | null | undefined): { body: string | null; dv: string | null } {
  if (!rut) return { body: null, dv: null };
  const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2) return { body: null, dv: null };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
}

// Map Bsale document type using codeSii (same logic as sync-bsale-docs)
function mapBsaleDocType(codeSii: number | undefined, name: string): string {
  // SII codes: 33=Factura, 34=Factura Exenta, 39=Boleta, 41=Boleta Exenta, 61=NC, 56=ND
  if (codeSii === 33) return 'factura';
  if (codeSii === 34) return 'factura_exenta';
  if (codeSii === 39 || codeSii === 41) return 'boleta';
  if (codeSii === 61) return 'nota_credito';
  if (codeSii === 56) return 'nota_debito';
  
  // Fallback by name
  const normalized = (name || '').toUpperCase();
  if (normalized.includes('NOTA DE CREDITO') || normalized.includes('NOTA CREDITO')) return 'nota_credito';
  if (normalized.includes('NOTA DE DEBITO') || normalized.includes('NOTA DEBITO')) return 'nota_debito';
  if (normalized.includes('FACTURA EXENTA')) return 'factura_exenta';
  if (normalized.includes('FACTURA')) return 'factura';
  if (normalized.includes('BOLETA')) return 'boleta';
  
  return 'boleta';
}

async function fetchBsaleDocument(accessToken: string, resourceId: number) {
  return await fetch(
    `https://api.bsale.cl/v1/documents/${resourceId}.json?expand=[details,client,document_type,references]`,
    {
      headers: {
        'access_token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  )
}

async function resolveBsaleAccount(
  supabase: ReturnType<typeof createClient>,
  cpnId: string,
  resourceId: number,
): Promise<{ bsaleAccount: BsaleAccount | null; bsaleResponse: Response | null }> {
  const normalizedCpnId = String(cpnId)

  const { data: exactAccount, error: accountError } = await supabase
    .from('bsale_accounts')
    .select('id, user_id, access_token, cpn_id')
    .eq('cpn_id', normalizedCpnId)
    .eq('status', 'connected')
    .maybeSingle()

  if (accountError) {
    console.error('Error looking up Bsale account by cpnId:', normalizedCpnId, accountError)
    return { bsaleAccount: null, bsaleResponse: null }
  }

  if (!exactAccount) return { bsaleAccount: null, bsaleResponse: null }

  // Never probe a resource against other tenant tokens. The public webhook
  // identifies its tenant exclusively by the cpnId registered at connection.
  return {
    bsaleAccount: exactAccount as BsaleAccount,
    bsaleResponse: await fetchBsaleDocument(exactAccount.access_token, resourceId),
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: corsHeaders })
  }

  console.log('Bsale webhook received')

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Parse webhook payload
    const payload = await readJsonBody<BsaleWebhookPayload>(req)

    const { cpnId, topic, resourceId, action } = payload
    const normalizedCpnId = String(cpnId)

    if (
      !['string', 'number'].includes(typeof cpnId) || !/^\d{1,30}$/.test(normalizedCpnId) ||
      typeof topic !== 'string' ||
      !Number.isSafeInteger(resourceId) || resourceId <= 0 ||
      typeof action !== 'string'
    ) {
      return new Response(JSON.stringify({ error: 'Invalid notification data' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Only process document webhooks (POST = created, PUT = updated)
    if (topic !== 'document') {
      console.log(`Ignoring webhook topic: ${topic}`)
      return new Response(JSON.stringify({ success: true, message: 'Ignored - not a document webhook' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // FIX: Case-insensitive check for action (Bsale sends lowercase "post"/"put")
    if (!['POST', 'PUT'].includes(action.toUpperCase())) {
      console.log(`Ignoring webhook action: ${action}`)
      return new Response(JSON.stringify({ success: true, message: 'Ignored - not POST or PUT action' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { bsaleAccount, bsaleResponse } = await resolveBsaleAccount(supabase, normalizedCpnId, resourceId)

    if (!bsaleAccount || !bsaleResponse) {
      console.error('Bsale account not found for cpnId:', cpnId)
      return new Response(JSON.stringify({ message: 'Acknowledged' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Found exact Bsale account for webhook tenant')

    if (!bsaleResponse.ok) {
      console.error('Failed to fetch document from Bsale:', bsaleResponse.status)
      return new Response(JSON.stringify({ error: 'Failed to fetch document from Bsale' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const document = await bsaleResponse.json()
    const rawCodeSii = document.document_type?.codeSii;
    const codeSii = rawCodeSii != null ? Number(rawCodeSii) : undefined;
    const typeName = (document.document_type?.name || '').toUpperCase();
    
    console.log('Fetched document:', document.id, document.number, 'codeSii:', codeSii, 'type:', typeName)

    // Filter non-tributary documents (Guías, Notas de Venta, etc.)
    // Valid SII codes: 33=Factura, 34=Factura Exenta, 39/41=Boleta, 61=NC, 56=ND
    const validSiiCodes = [33, 34, 39, 41, 61, 56];
    
    if (codeSii === 52 || 
        typeName.includes('GUÍA DE DESPACHO') || 
        typeName.includes('GUIA DE DESPACHO') ||
        (!codeSii && typeName.includes('NOTA VENTA')) ||
        (codeSii && !validSiiCodes.includes(codeSii))) {
      console.log(`Ignoring non-tributary document: ${document.id} (codeSii: ${codeSii}, type: ${typeName})`);
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Ignored - non-tributary document',
        documentId: document.id,
        typeName: typeName,
        codeSii: codeSii
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Map document type using codeSii
    const documentType = mapBsaleDocType(codeSii, document.document_type?.name || '');

    // Enhanced extraction of external order id from multiple fields
    let externalOrderId: string | null = null;
    
    // 1. Check client note first
    if (document.client?.note) {
      const orderMatch = document.client.note.match(/(\d{10,})/);
      if (orderMatch) {
        externalOrderId = orderMatch[1];
        console.log('Found order ID in client.note:', externalOrderId);
      }
    }
    
    // 2. Check reference field
    if (!externalOrderId && document.reference) {
      const orderMatch = document.reference.match(/(\d{10,})/);
      if (orderMatch) {
        externalOrderId = orderMatch[1];
        console.log('Found order ID in reference:', externalOrderId);
      }
    }

    // 3. Check references array (from expand)
    if (!externalOrderId && document.references?.items?.length > 0) {
      for (const ref of document.references.items) {
        const searchText = `${ref.reason || ''} ${ref.number || ''}`;
        const orderMatch = searchText.match(/(\d{10,})/);
        if (orderMatch) {
          externalOrderId = orderMatch[1];
          console.log('Found order ID in references:', externalOrderId);
          break;
        }
      }
    }

    // 4. Check details comments
    if (!externalOrderId && document.details?.items?.length > 0) {
      for (const detail of document.details.items) {
        if (detail.comment) {
          const orderMatch = detail.comment.match(/(\d{10,})/);
          if (orderMatch) {
            externalOrderId = orderMatch[1];
            console.log('Found order ID in detail comment:', externalOrderId);
            break;
          }
        }
      }
    }

    // Prepare tax document data
    const taxDocumentData = {
      user_id: bsaleAccount.user_id,
      external_system: 'bsale',
      external_id: String(document.id),
      document_number: String(document.number || document.id),
      document_type: documentType,
      document_date: document.emissionDate 
        ? new Date(document.emissionDate * 1000).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      total_amount: document.totalAmount || 0,
      net_amount: document.netAmount || 0,
      tax_amount: document.taxAmount || 0,
      client_name: document.client?.firstName 
        ? `${document.client.firstName} ${document.client.lastName || ''}`.trim()
        : document.client?.company || null,
      client_tax_id: splitRut(document.client?.code).body,
      client_tax_id_dv: splitRut(document.client?.code).dv,
      external_order_id: externalOrderId,
      external_url: document.urlPublicViewOriginal || document.urlPdf || null,
      status: document.state === 0 ? 'issued' : document.state === 1 ? 'voided' : 'issued',
      raw_data: document,
    }

    console.log('Upserting tax document:', taxDocumentData.document_number, 'type:', documentType)

    // Upsert the tax document
    const { data: taxDoc, error: upsertError } = await supabase
      .from('tax_documents')
      .upsert(taxDocumentData, {
        onConflict: 'user_id,external_system,external_id',
      })
      .select()
      .single()

    if (upsertError) {
      console.error('Error upserting tax document:', upsertError)
      return new Response(JSON.stringify({ error: 'Failed to save document' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Tax document saved:', taxDoc.id)

    // Try to auto-link to an order
    let linkedOrderId: string | null = null
    
    // Stage 1: Exact match by external_order_id
    if (externalOrderId) {
      console.log('Attempting exact match with external_sale_id:', externalOrderId)

      const { data: matchingOrder } = await supabase
        .from('orders')
        .select('id')
        .eq('external_sale_id', externalOrderId)
        .maybeSingle()

      if (matchingOrder) {
        // Check if link already exists
        const { data: existingLink } = await supabase
          .from('order_tax_documents')
          .select('id')
          .eq('order_id', matchingOrder.id)
          .eq('tax_document_id', taxDoc.id)
          .maybeSingle()

        if (!existingLink) {
          const { error: linkError } = await supabase
            .from('order_tax_documents')
            .insert({
              order_id: matchingOrder.id,
              tax_document_id: taxDoc.id,
              created_by: bsaleAccount.user_id,
              match_source: 'webhook_external_order_id',
              match_score: 100,
            })

          if (linkError) {
            console.error('Error linking document to order:', linkError)
          } else {
            console.log('Document auto-linked to order via exact match:', matchingOrder.id)
            linkedOrderId = matchingOrder.id
          }
        } else {
          linkedOrderId = matchingOrder.id
        }
      } else {
        console.log('No matching order found for external_sale_id:', externalOrderId)
      }
    }

    // Stage 2: Fallback scoring for boletas (amount + date match)
    if (!linkedOrderId && documentType === 'boleta' && document.emissionDate) {
      console.log('Attempting fallback scoring for boleta...');
      
      const docDate = new Date(document.emissionDate * 1000);
      const dayBefore = new Date(docDate.getTime() - 86400000).toISOString();
      const dayAfter = new Date(docDate.getTime() + 86400000).toISOString();
      
      // Find orders with exact amount and date ±1 day
      const { data: candidateOrders } = await supabase
        .from('orders')
        .select('id, order_id, gross_amount, customer_name, customer_tax_id, order_date')
        .eq('gross_amount', document.totalAmount)
        .gte('order_date', dayBefore)
        .lte('order_date', dayAfter);

      console.log(`Found ${candidateOrders?.length || 0} candidate orders for boleta matching`);

      if (candidateOrders?.length === 1) {
        // Single match = auto-link with score 80
        const order = candidateOrders[0];
        
        // Verify the order doesn't already have a linked document
        const { data: existingLink } = await supabase
          .from('order_tax_documents')
          .select('id')
          .eq('order_id', order.id)
          .maybeSingle();

        if (!existingLink) {
          const { error: linkError } = await supabase
            .from('order_tax_documents')
            .insert({
              order_id: order.id,
              tax_document_id: taxDoc.id,
              created_by: bsaleAccount.user_id,
              match_source: 'webhook_fallback_boleta',
              match_score: 80,
            });

          if (!linkError) {
            linkedOrderId = order.id;
            console.log(`Boleta auto-linked via fallback to order ${order.order_id} (score 80)`);
          } else {
            console.error('Error in fallback link:', linkError);
          }
        } else {
          console.log('Order already has a linked document, skipping fallback');
        }
      } else if (candidateOrders && candidateOrders.length > 1) {
        console.log(`Multiple candidates (${candidateOrders.length}) for boleta - skipping auto-link to avoid ambiguity`);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      documentId: taxDoc.id,
      documentType: documentType,
      linkedOrderId: linkedOrderId,
      externalOrderId: externalOrderId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Webhook error:', error)
    const status = error instanceof HttpInputError ? error.status : 500
    return new Response(JSON.stringify({
      error: error instanceof HttpInputError ? error.message : 'Internal server error',
    }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
