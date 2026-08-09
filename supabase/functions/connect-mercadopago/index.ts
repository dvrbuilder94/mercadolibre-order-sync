import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

// Conexión de Mercado Pago mediante Access Token de producción (Tus integraciones
// → Credenciales de producción). Se valida contra /users/me antes de guardar y se
// usa siempre en modo lectura: pagos, liquidaciones y reportes.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ success: false, error: 'No autorizado' }, 401)
    }
    const { data: claims, error: claimsError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    )
    if (claimsError || !claims.user) return json({ success: false, error: 'No autorizado' }, 401)
    const userId = claims.user.id

    const { access_token } = await req.json().catch(() => ({}))
    if (!access_token || typeof access_token !== 'string' || !access_token.trim()) {
      return json({ success: false, error: 'El access token es requerido' }, 400)
    }
    const accessToken = access_token.trim()

    if (accessToken.startsWith('TEST-')) {
      return json({
        success: false,
        error: 'Ese es un token de prueba (TEST-). Usa las credenciales de producción (APP_USR-).',
      }, 400)
    }

    const meResponse = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!meResponse.ok) {
      const detail = await meResponse.text().catch(() => '')
      console.error('MP /users/me error:', meResponse.status, detail)
      return json({
        success: false,
        error: meResponse.status === 401
          ? 'Token inválido o revocado en Mercado Pago.'
          : 'No se pudo validar el token con Mercado Pago.',
      }, 400)
    }

    const me = await meResponse.json()

    const { error: upsertError } = await supabase
      .from('mercadopago_accounts')
      .upsert({
        user_id: userId,
        access_token: accessToken,
        mp_user_id: String(me.id),
        nickname: me.nickname ?? null,
        email: me.email ?? null,
        site_id: me.site_id ?? null,
        status: 'connected',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,mp_user_id' })

    if (upsertError) {
      console.error('Error guardando cuenta MP:', upsertError)
      return json({ success: false, error: 'No se pudo guardar la conexión.' }, 500)
    }

    return json({ success: true, nickname: me.nickname, mpUserId: String(me.id) })
  } catch (error) {
    console.error('connect-mercadopago error:', error)
    return json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})
