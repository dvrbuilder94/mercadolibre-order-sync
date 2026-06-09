import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const token = authHeader.replace('Bearer ', '')
    const { data: claims, error: claimsError } = await supabase.auth.getClaims(token)
    if (claimsError || !claims?.claims) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    const userId = claims.claims.sub as string

    // Get MELI account to verify user has one
    const { data: meliAccount, error: meliError } = await supabase
      .from('meli_accounts')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    if (meliError || !meliAccount) {
      return new Response(JSON.stringify({ 
        error: 'No MercadoLibre account connected',
        details: meliError?.message 
      }), { 
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // Calculate date range (last 30 days)
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Fetch LOCAL orders from database (no API call needed)
    const { data: localOrders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .gte('order_date', thirtyDaysAgo.toISOString())
      .order('order_date', { ascending: false })
      .limit(50)

    if (ordersError) {
      return new Response(JSON.stringify({ 
        error: 'Error fetching orders',
        details: ordersError.message 
      }), { 
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // Process orders to extract matching-relevant fields from raw_data
    const processedOrders = (localOrders || []).map(order => {
      const rawData = order.raw_data || {}
      const buyer = rawData.buyer || {}
      const payment = rawData.payments?.[0] || {}
      
      return {
        // IDs from DB
        db_id: order.id,
        order_id: order.order_id,
        external_sale_id: order.external_sale_id,
        
        // IDs from raw_data
        pack_id: rawData.pack_id?.toString() || null,
        shipping_id: order.shipping_id || rawData.shipping?.id?.toString() || null,
        payment_id: payment.id?.toString() || null,
        
        // Dates
        order_date: order.order_date,
        payment_date: payment.date_approved || payment.date_created || null,
        
        // Amounts
        gross_amount: order.gross_amount,
        total_amount: order.amount,
        paid_amount: rawData.paid_amount,
        currency: order.currency_id,
        
        // Buyer info (useful for matching by name/RUT)
        customer_name: order.customer_name,
        customer_tax_id: order.customer_tax_id,
        buyer_nickname: buyer.nickname || null,
        buyer_email: order.customer_email,
        buyer_doc_type: buyer.billing_info?.doc_type || null,
        buyer_doc_number: buyer.billing_info?.doc_number || null,
        
        // Status
        order_status: order.status,
        payment_status: payment.status || null,
        
        // Product info
        product_title: order.product_title,
        seller_sku: order.seller_sku,
        
        // Text fields for reference matching
        bank_reference: order.bank_reference,
        payment_reference: payment.reference || null,
      }
    })

    // Also fetch tax_documents for comparison
    const { data: taxDocs } = await supabase
      .from('tax_documents')
      .select('id, document_number, document_type, document_date, total_amount, client_name, client_tax_id, external_order_id, raw_data')
      .eq('user_id', userId)
      .gte('document_date', thirtyDaysAgo.toISOString().split('T')[0])
      .order('document_date', { ascending: false })
      .limit(50)

    // Extract useful fields from tax docs
    const processedTaxDocs = (taxDocs || []).map(doc => {
      const rawData = doc.raw_data || {}
      return {
        id: doc.id,
        document_number: doc.document_number,
        document_type: doc.document_type,
        document_date: doc.document_date,
        total_amount: doc.total_amount,
        client_name: doc.client_name,
        client_tax_id: doc.client_tax_id,
        external_order_id: doc.external_order_id,
        // Fields that might contain order references
        client_note: rawData.client?.note || null,
        references: rawData.references || null,
        details_comments: rawData.details?.map((d: any) => d.comment).filter(Boolean) || [],
      }
    })

    return new Response(JSON.stringify({
      success: true,
      mode: 'LOCAL_DATA',
      summary: {
        orders_count: processedOrders.length,
        tax_docs_count: processedTaxDocs.length,
        date_range: { 
          from: thirtyDaysAgo.toISOString().split('T')[0], 
          to: now.toISOString().split('T')[0] 
        },
      },
      orders: processedOrders,
      tax_documents: processedTaxDocs,
      matching_hints: {
        primary_match: ['customer_tax_id ↔ client_tax_id (RUT)'],
        secondary_match: ['gross_amount ↔ total_amount (±500)', 'order_date ↔ document_date (±2 días)'],
        text_search: ['customer_name ↔ client_name', 'product_title en details_comments']
      }
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error in debug-meli-matching:', error)
    return new Response(JSON.stringify({ 
      error: 'Internal error',
      details: errorMessage 
    }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})
