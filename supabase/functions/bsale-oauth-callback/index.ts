import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  console.log('Bsale OAuth callback received')

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Get Bsale credentials
    const bsaleAppId = Deno.env.get('BSALE_APP_ID')
    const bsaleUsrToken = Deno.env.get('BSALE_USR_TOKEN')

    if (!bsaleAppId || !bsaleUsrToken) {
      console.error('Bsale credentials not configured')
      return redirectWithError('Configuración Bsale incompleta')
    }

    // Parse callback parameters
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    console.log('OAuth callback params:', { code: !!code, error })

    // Check for OAuth errors
    if (error) {
      console.error('Bsale OAuth error:', error)
      return redirectWithError(`Bsale rechazó la autorización: ${error}`)
    }

    if (!code) {
      console.error('Missing code')
      return redirectWithError('Código de autorización faltante')
    }

    // Find the pending bsale_account by looking for one with oauth_state set
    // Since Bsale doesn't return state, we find the most recent pending account
    const { data: bsaleAccounts, error: findError } = await supabase
      .from('bsale_accounts')
      .select('id, user_id, client_code, oauth_state')
      .not('oauth_state', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(5)

    if (findError || !bsaleAccounts || bsaleAccounts.length === 0) {
      console.error('No pending accounts found:', findError)
      return redirectWithError('No se encontró sesión OAuth pendiente')
    }

    // Use the most recent one (ideally we'd match by state if Bsale returned it)
    const bsaleAccount = bsaleAccounts[0]
    console.log('Found account for user:', bsaleAccount.user_id)

    // Exchange code for access_token using Bsale's endpoint
    // POST to https://oauth.bsale.io/gateway/oauth_response.json
    const tokenResponse = await fetch('https://oauth.bsale.io/gateway/oauth_response.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: code,
        appId: bsaleAppId,
        usrToken: bsaleUsrToken,
      }),
    })

    const tokenText = await tokenResponse.text()
    console.log('Token response status:', tokenResponse.status)
    
    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', tokenResponse.status, tokenText)
      return redirectWithError('Error al obtener token de Bsale')
    }

    let tokenData
    try {
      tokenData = JSON.parse(tokenText)
    } catch (e) {
      console.error('Failed to parse token response:', tokenText)
      return redirectWithError('Respuesta inválida de Bsale')
    }

    console.log('Token exchange successful, keys:', Object.keys(tokenData))

    // Extract access_token and client info from response
    const accessToken = tokenData.access_token || tokenData.accessToken || tokenData.token
    const clientName = tokenData.client_name || tokenData.clientName || tokenData.nombre || null
    const cpnId = tokenData.cpn_id || tokenData.cpnId || tokenData.id || null

    if (!accessToken) {
      console.error('No access_token in response:', tokenData)
      return redirectWithError('No se recibió token de acceso')
    }

    // Update bsale_accounts with token
    const webhookUrl = `${supabaseUrl}/functions/v1/bsale-webhook`
    
    const { error: updateError } = await supabase
      .from('bsale_accounts')
      .update({
        access_token: accessToken,
        cpn_id: cpnId ? String(cpnId) : bsaleAccount.client_code, // Use cpn_id from response or client_code
        client_name: clientName,
        webhook_url: webhookUrl,
        oauth_state: null, // Clear state after successful OAuth
        app_client_id: bsaleAppId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bsaleAccount.id)

    if (updateError) {
      console.error('Error updating account:', updateError)
      return redirectWithError('Error al guardar credenciales')
    }

    console.log('Bsale OAuth completed successfully for user:', bsaleAccount.user_id)

    // Redirect to config page with success
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/config?bsale=success',
      },
    })

  } catch (error) {
    console.error('OAuth callback error:', error)
    return redirectWithError('Error interno del servidor')
  }
})

function redirectWithError(message: string): Response {
  const encodedMessage = encodeURIComponent(message)
  return new Response(null, {
    status: 302,
    headers: {
      'Location': `/config?bsale=error&message=${encodedMessage}`,
    },
  })
}
