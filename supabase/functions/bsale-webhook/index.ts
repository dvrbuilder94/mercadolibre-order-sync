import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { HttpInputError, readJsonBody } from '../_shared/http.ts'
import {
  buildTaxDocumentPayload,
  isValidTributaryDoc,
  mergePaymentEnrichment,
  normalizeCodeSii,
  unresolvedPaymentTypeIds,
} from '../_shared/bsale-document.ts'

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

async function fetchBsaleDocument(accessToken: string, resourceId: number) {
  return await fetch(
    `https://api.bsale.cl/v1/documents/${resourceId}.json?expand=[details,client,document_type,references,coin,payments]`,
    {
      headers: {
        'access_token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  )
}

// Resuelve nombres de payment_type sólo cuando el documento no los trae.
async function resolvePaymentTypeNames(accessToken: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  try {
    for (let offset = 0; offset < 500; offset += 50) {
      const response = await fetch(
        `https://api.bsale.cl/v1/payment_types.json?limit=50&offset=${offset}`,
        { headers: { 'access_token': accessToken, 'Content-Type': 'application/json' } },
      )
      if (!response.ok) break
      const data = await response.json().catch(() => null)
      const items: any[] = data?.items || []
      for (const item of items) {
        if (item?.id != null && item?.name) map.set(String(item.id), String(item.name))
      }
      if (items.length < 50) break
    }
  } catch (error) {
    console.warn('No se pudo cargar payment_types:', (error as any)?.message)
  }
  return map
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
    const codeSii = normalizeCodeSii(document?.document_type?.codeSii)
    const typeName = String(document?.document_type?.name || '').toUpperCase()

    console.log('Fetched document:', document?.id, document?.number, 'codeSii:', codeSii, 'type:', typeName)

    // Filtro estricto: sólo documentos tributarios válidos (33/34/39/41/56/61).
    // Sin fallback por nombre a `boleta`.
    if (!isValidTributaryDoc(document)) {
      console.log(`Ignoring non-tributary document: ${document?.id} (codeSii: ${codeSii}, type: ${typeName})`)
      return new Response(JSON.stringify({
        success: true,
        message: 'Ignored - non-tributary document',
        documentId: document?.id,
        typeName,
        codeSii,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Resolver nombres de forma de pago sólo si el documento no los trae.
    const pendingTypeIds = unresolvedPaymentTypeIds(document)
    const paymentTypeNames = await resolvePaymentTypeNames(bsaleAccount.access_token, pendingTypeIds)

    // Normalizador canónico compartido con el full sync.
    const taxDocumentData = buildTaxDocumentPayload(document, {
      userId: bsaleAccount.user_id,
      paymentTypeNames,
    })

    if (!taxDocumentData) {
      return new Response(JSON.stringify({ success: true, message: 'Ignored - unmapped document type' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Un webhook incompleto no debe borrar la forma de pago ya conocida.
    const { data: existing } = await supabase
      .from('tax_documents')
      .select('raw_data')
      .eq('user_id', bsaleAccount.user_id)
      .eq('external_system', 'bsale')
      .eq('external_id', taxDocumentData.external_id)
      .maybeSingle()

    taxDocumentData.raw_data = mergePaymentEnrichment(
      taxDocumentData.raw_data,
      (existing as any)?.raw_data ?? null,
    )

    console.log('Upserting tax document:', taxDocumentData.document_number, 'type:', taxDocumentData.document_type)

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

    // El matching venta ↔ DTE pertenece exclusivamente a `auto-reconcile`.
    // El webhook sólo ingiere/actualiza la verdad tributaria.
    return new Response(JSON.stringify({
      success: true,
      documentId: taxDoc.id,
      documentType: taxDocumentData.document_type,
      externalOrderId: taxDocumentData.external_order_id,
      matching: 'deferred_to_auto_reconcile',
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
