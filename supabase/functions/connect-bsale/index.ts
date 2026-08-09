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

  console.log('Connect Bsale request received')

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Get authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Validate user JWT
    const token = authHeader.replace('Bearer ', '')
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token)

    if (claimsError || !claimsData.user) {
      console.error('Auth error:', claimsError)
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const userId = claimsData.user.id
    console.log('Authenticated user:', userId)

    // Parse request body
    const body = await req.json().catch(() => ({}))
    const { accessToken } = body

    if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Access token es requerido' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const trimmedToken = accessToken.trim()

    // Validate token against Bsale API
    console.log('Validating token against Bsale API...')
    
    const bsaleResponse = await fetch('https://api.bsale.io/v1/users.json', {
      method: 'GET',
      headers: {
        'access_token': trimmedToken,
        'Content-Type': 'application/json',
      },
    })

    if (!bsaleResponse.ok) {
      console.error('Bsale API error:', bsaleResponse.status)
      
      if (bsaleResponse.status === 401 || bsaleResponse.status === 403) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Token inválido o sin permisos. Verifica que el token sea correcto.' 
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Error al validar token con Bsale. Intenta nuevamente.' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const bsaleData = await bsaleResponse.json()
    console.log('Bsale API response received, keys:', Object.keys(bsaleData))

    // Extract a display name from the validated user response. Do not use the
    // user ID as cpn_id: Bsale webhooks send the company ID, and confusing the
    // two makes every valid webhook look as if it belonged to another tenant.
    let companyName: string | null = null
    let cpnId: string | null = null

    if (bsaleData.items && Array.isArray(bsaleData.items) && bsaleData.items.length > 0) {
      const firstUser = bsaleData.items[0]
      companyName = firstUser.firstName || firstUser.name || null
      cpnId = firstUser.cpnId?.toString() || firstUser.company?.id?.toString() || null
    } else {
      companyName = bsaleData.firstName || bsaleData.name || null
      cpnId = bsaleData.cpnId?.toString() || bsaleData.company?.id?.toString() || null
    }

    // The canonical fallback is the company endpoint, never a generated ID.
    if (!cpnId) {
      console.log('Trying to get company info from /v1/companies.json...')
      const companiesResponse = await fetch('https://api.bsale.io/v1/companies.json', {
        method: 'GET',
        headers: {
          'access_token': trimmedToken,
          'Content-Type': 'application/json',
        },
      })

      if (companiesResponse.ok) {
        const companiesData = await companiesResponse.json()
        if (companiesData.items && companiesData.items.length > 0) {
          const company = companiesData.items[0]
          cpnId = company.id?.toString() || null
          companyName = company.name || company.fantasyName || companyName
        }
      }
    }

    if (!cpnId || !/^\d{1,30}$/.test(cpnId)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'El token es válido, pero Bsale no informó el ID de empresa necesario para configurar los webhooks.',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Company info extracted:', { cpnId, companyName })

    // Save to bsale_accounts with status connected
    const webhookUrl = `${supabaseUrl}/functions/v1/bsale-webhook`
    
    const { error: upsertError } = await supabase
      .from('bsale_accounts')
      .upsert({
        user_id: userId,
        access_token: trimmedToken,
        cpn_id: cpnId,
        client_name: companyName,
        webhook_url: webhookUrl,
        status: 'connected',
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id'
      })

    if (upsertError) {
      console.error('Error saving to database:', upsertError)
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Error al guardar credenciales. Intenta nuevamente.' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Bsale account saved successfully for user:', userId)

    return new Response(JSON.stringify({ 
      success: true,
      companyName: companyName || cpnId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Error interno del servidor' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
