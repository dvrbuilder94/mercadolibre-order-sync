import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  console.log('[fetch-bsale-documents] Request received')

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Authenticate user via JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token)

    if (claimsError || !claimsData.user) {
      console.error('[fetch-bsale-documents] Auth error:', claimsError)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const userId = claimsData.user.id
    console.log('[fetch-bsale-documents] Authenticated user:', userId)

    // Get Bsale account for user
    const { data: bsaleAccount, error: bsaleError } = await supabase
      .from('bsale_accounts')
      .select('access_token, cpn_id, client_name, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (bsaleError) {
      console.error('[fetch-bsale-documents] DB error:', bsaleError)
      return new Response(JSON.stringify({ error: 'Error fetching Bsale account' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!bsaleAccount || bsaleAccount.status !== 'connected') {
      return new Response(JSON.stringify({ error: 'Bsale account not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const bsaleToken = bsaleAccount.access_token
    console.log('[fetch-bsale-documents] Bsale account found, cpn_id:', bsaleAccount.cpn_id)

    // Calculate Unix timestamps for last 30 days
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const emissionDateFrom = Math.floor(thirtyDaysAgo.getTime() / 1000)
    const emissionDateTo = Math.floor(now.getTime() / 1000)

    console.log('[fetch-bsale-documents] Date range:', {
      from: thirtyDaysAgo.toISOString(),
      to: now.toISOString(),
      emissionDateFrom,
      emissionDateTo,
    })

    // Call Bsale API to fetch documents
    // Expand details and client to get full document info
    const bsaleUrl = new URL('https://api.bsale.io/v1/documents.json')
    bsaleUrl.searchParams.set('emissiondaterange', `[${emissionDateFrom},${emissionDateTo}]`)
    bsaleUrl.searchParams.set('limit', '20')
    bsaleUrl.searchParams.set('offset', '0')
    bsaleUrl.searchParams.set('expand', '[details,client,document_type]')

    console.log('[fetch-bsale-documents] Calling Bsale API:', bsaleUrl.toString())

    const bsaleResponse = await fetch(bsaleUrl.toString(), {
      method: 'GET',
      headers: {
        'access_token': bsaleToken,
        'Content-Type': 'application/json',
      },
    })

    if (!bsaleResponse.ok) {
      const errorText = await bsaleResponse.text()
      console.error('[fetch-bsale-documents] Bsale API error:', bsaleResponse.status, errorText)
      
      if (bsaleResponse.status === 401 || bsaleResponse.status === 403) {
        return new Response(JSON.stringify({ 
          error: 'Token de Bsale inválido o expirado',
          status: bsaleResponse.status,
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      
      return new Response(JSON.stringify({ 
        error: 'Error al consultar Bsale API',
        status: bsaleResponse.status,
        details: errorText,
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Return raw Bsale response
    const bsaleData = await bsaleResponse.json()
    console.log('[fetch-bsale-documents] Success, document count:', bsaleData.count || bsaleData.items?.length || 0)

    return new Response(JSON.stringify({
      success: true,
      bsale_account: {
        cpn_id: bsaleAccount.cpn_id,
        client_name: bsaleAccount.client_name,
      },
      date_range: {
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString(),
      },
      raw_response: bsaleData,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('[fetch-bsale-documents] Unexpected error:', errorMessage)
    return new Response(JSON.stringify({ 
      error: 'Error interno del servidor',
      details: errorMessage,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
