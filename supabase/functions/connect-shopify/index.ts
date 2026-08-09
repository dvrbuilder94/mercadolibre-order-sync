import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  SHOPIFY_API_VERSION,
  normalizeShopDomain,
  mintAccessToken,
  ShopifyAuthError,
} from '../_shared/shopify-account.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ success: false, error: 'No authorization header' }, 401)
    }

    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    )
    if (claimsError || !claimsData.user) {
      return json({ success: false, error: 'Unauthorized' }, 401)
    }
    const userId = claimsData.user.id

    const body = await req.json().catch(() => ({}))
    const shopDomainRaw = typeof body.shop_domain === 'string' ? body.shop_domain : ''
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    // El secret puede venir del formulario o estar guardado como secreto del backend.
    const clientSecret = (typeof body.client_secret === 'string' && body.client_secret.trim())
      || Deno.env.get('SHOPIFY_CLIENT_SECRET')
      || Deno.env.get('SHOPIFY_ACCESS_TOKEN')
      || ''
    const pastedToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''

    if (!shopDomainRaw.trim()) return json({ success: false, error: 'shop_domain es requerido' }, 400)
    if (!pastedToken && (!clientId || !clientSecret)) {
      return json({ success: false, error: 'Pegá el token de la app (shpat_…) o el Client ID + Client Secret' }, 400)
    }
    if (pastedToken && !/^shp(at|ca|ss)_/.test(pastedToken)) {
      return json({ success: false, error: 'El token de la Admin API debe empezar con shpat_ (lo copiás al instalar la Custom App).' }, 400)
    }

    const shopDomain = normalizeShopDomain(shopDomainRaw)
    if (!shopDomain.endsWith('.myshopify.com')) {
      return json({
        success: false,
        error: `El shop domain debe ser el dominio interno de Shopify (ej: mitienda.myshopify.com), no "${shopDomain}". Lo encontrás en la URL del admin: admin.shopify.com/store/mitienda.`,
      }, 400)
    }

    // 1) Token: pegado (Custom App, permanente) o generado vía client_credentials (24h).
    let minted: { accessToken: string; expiresAt: string | null }
    if (pastedToken) {
      minted = { accessToken: pastedToken, expiresAt: null }
    } else {
      try {
        minted = await mintAccessToken(shopDomain, clientId, clientSecret)
      } catch (e) {
        const message = e instanceof ShopifyAuthError
          ? e.message
          : 'No se pudo obtener el token de Shopify. Verificá el dominio y las credenciales.'
        console.error('Shopify token exchange failed for shop:', shopDomain)
        return json({ success: false, error: message }, 400)
      }
    }

    // 2) Validación real: consulta GraphQL de solo lectura.
    const probe = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': minted.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    })

    if (!probe.ok) {
      console.error('Shopify shop query failed with status', probe.status)
      return json({
        success: false,
        error: probe.status === 401 || probe.status === 403
          ? `Shopify entregó el token pero rechazó la consulta (${probe.status}). Casi siempre es porque la app todavía no está instalada en ${shopDomain}: abrí la app en el Dev Dashboard, elegí esa tienda y hacé clic en "Install". Verificá también los scopes read_orders y read_products.`
          : 'No se pudo consultar la tienda en Shopify.',
      }, 400)
    }

    const probeData = await probe.json().catch(() => null)
    if (probeData?.errors || !probeData?.data?.shop) {
      console.error('Shopify GraphQL rejected the shop query')
      return json({ success: false, error: 'La app no tiene permisos de lectura sobre la tienda.' }, 400)
    }

    const shopName = probeData.data.shop.name || shopDomain

    // 3) Recién con la consulta OK persistimos y marcamos conectado.
    const { error: upsertError } = await supabase
      .from('shopify_accounts')
      .upsert({
        user_id: userId,
        shop_domain: shopDomain,
        client_id: pastedToken ? null : clientId,
        client_secret: pastedToken ? null : clientSecret,
        access_token: minted.accessToken,
        token_expires_at: minted.expiresAt,
        status: 'connected',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

    if (upsertError) {
      console.error('Error saving Shopify account:', upsertError.message)
      return json({ success: false, error: 'Error al guardar la conexión. Intentá nuevamente.' }, 500)
    }

    console.log('Shopify connected for user:', userId, '| shop:', shopDomain)
    return json({ success: true, shopName })
  } catch (error) {
    console.error('Unexpected error in connect-shopify')
    return json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})
