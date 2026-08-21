import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  SHOPIFY_API_VERSION,
  normalizeShopDomain,
  mintAccessToken,
  ShopifyAuthError,
} from '../_shared/shopify-account.ts'
import { orgAdminErrorStatus, requireOrgAdmin } from '../_shared/org-admin.ts'

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

    let adminContext
    try {
      adminContext = await requireOrgAdmin(supabase, req.headers.get('Authorization'))
    } catch (error) {
      return json({ success: false, error: 'No autorizado para administrar conexiones' }, orgAdminErrorStatus(error))
    }

    const body = await req.json().catch(() => ({}))
    const shopDomainRaw = typeof body.shop_domain === 'string' ? body.shop_domain : ''
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    const clientSecret = (typeof body.client_secret === 'string' && body.client_secret.trim())
      || Deno.env.get('SHOPIFY_CLIENT_SECRET')
      || ''
    const pastedToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''

    if (!shopDomainRaw.trim()) return json({ success: false, error: 'shop_domain es requerido' }, 400)
    if (!pastedToken && (!clientId || !clientSecret)) {
      return json({ success: false, error: 'Pegá el token de la app (shpat_…) o el Client ID + Client Secret' }, 400)
    }
    if (pastedToken && !/^shp(at|ca|ss)_/.test(pastedToken)) {
      return json({ success: false, error: 'El token de la Admin API debe empezar con shpat_.' }, 400)
    }

    const shopDomain = normalizeShopDomain(shopDomainRaw)
    if (!shopDomain.endsWith('.myshopify.com')) {
      return json({ success: false, error: `El shop domain debe terminar en .myshopify.com, no "${shopDomain}".` }, 400)
    }

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
        return json({ success: false, error: message }, 400)
      }
    }

    const probe = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': minted.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    })

    if (!probe.ok) {
      return json({
        success: false,
        error: probe.status === 401 || probe.status === 403
          ? `Shopify rechazó la consulta (${probe.status}). Verificá instalación y scopes.`
          : 'No se pudo consultar la tienda en Shopify.',
      }, 400)
    }

    const probeData = await probe.json().catch(() => null)
    if (probeData?.errors || !probeData?.data?.shop) {
      return json({ success: false, error: 'La app no tiene permisos de lectura sobre la tienda.' }, 400)
    }

    const shopName = probeData.data.shop.name || shopDomain

    const { error: upsertError } = await supabase
      .from('shopify_accounts')
      .upsert({
        user_id: adminContext.ownerUserId,
        organization_id: adminContext.organizationId,
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

    return json({ success: true, shopName })
  } catch (error) {
    console.error('Unexpected error in connect-shopify', error)
    return json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})
