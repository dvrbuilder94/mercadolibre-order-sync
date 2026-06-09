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

  console.log('Getting Bsale OAuth URL...')

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Get authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Get user from token
    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )

    if (userError || !user) {
      console.error('Auth error:', userError)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Parse request body for client_code (RUT)
    const { client_code } = await req.json().catch(() => ({}))
    
    if (!client_code) {
      return new Response(JSON.stringify({ 
        error: 'client_code (RUT) is required',
        needsClientCode: true 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Get Bsale app_id from secrets
    const bsaleAppId = Deno.env.get('BSALE_APP_ID')

    if (!bsaleAppId) {
      console.error('BSALE_APP_ID not configured')
      return new Response(JSON.stringify({ 
        error: 'Bsale app_id not configured. Contact support.',
        needsManualSetup: true 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Generate state for CSRF protection
    const state = crypto.randomUUID()
    
    // Store state and client_code temporarily in bsale_accounts
    const { error: upsertError } = await supabase
      .from('bsale_accounts')
      .upsert({
        user_id: user.id,
        oauth_state: state,
        client_code: client_code.trim(),
        access_token: '', // Placeholder, will be updated after OAuth
      }, {
        onConflict: 'user_id'
      })

    if (upsertError) {
      console.error('Error storing OAuth state:', upsertError)
      return new Response(JSON.stringify({ error: 'Failed to initiate OAuth' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Build Bsale OAuth URL
    // Bsale uses: https://oauth.bsale.io/login
    const redirectUri = `${supabaseUrl}/functions/v1/bsale-oauth-callback`
    
    const authUrl = new URL('https://oauth.bsale.io/login')
    authUrl.searchParams.set('app_id', bsaleAppId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('client_code', client_code.trim()) // RUT de la empresa

    console.log('Generated Bsale OAuth URL for user:', user.id, 'client_code:', client_code)

    return new Response(JSON.stringify({ 
      url: authUrl.toString(),
      redirectUri: redirectUri,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Error generating Bsale auth URL:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
