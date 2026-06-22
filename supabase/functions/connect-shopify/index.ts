import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Quarterly Shopify API version (YYYY-MM, e.g. 2026-04/07/10). Bump
// periodically — Shopify keeps each version live for ~1 year after release.
const SHOPIFY_API_VERSION = '2026-04'

function normalizeShopDomain(input: string): string {
  let domain = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!domain.includes('.')) domain = `${domain}.myshopify.com`
  return domain
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

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

    const body = await req.json().catch(() => ({}))
    const { shop_domain, access_token } = body

    if (!shop_domain || typeof shop_domain !== 'string' || !shop_domain.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'shop_domain es requerido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!access_token || typeof access_token !== 'string' || !access_token.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'access_token es requerido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const shopDomain = normalizeShopDomain(shop_domain)
    const accessToken = access_token.trim()

    // Validate credentials against Shopify before saving anything.
    console.log(`Validating Shopify credentials for ${shopDomain}...`)
    const shopifyResponse = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    })

    if (!shopifyResponse.ok) {
      const detail = await shopifyResponse.text().catch(() => '')
      console.error('Shopify API error:', shopifyResponse.status, detail)

      if (shopifyResponse.status === 401 || shopifyResponse.status === 403) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Token inválido o sin permisos. Verifica el Admin API access token y que la app tenga el scope read_orders.',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({
        success: false,
        error: 'No se pudo conectar con Shopify. Verifica el shop domain (ej: mitienda.myshopify.com).',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const shopifyData = await shopifyResponse.json()

    if (shopifyData.errors || !shopifyData.data?.shop) {
      console.error('Shopify GraphQL errors:', shopifyData.errors)
      return new Response(JSON.stringify({
        success: false,
        error: 'Token inválido o sin permisos en Shopify.',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const shopName = shopifyData.data.shop.name || shopDomain
    console.log(`Shopify shop validated: ${shopName}`)

    const { error: upsertError } = await supabase
      .from('shopify_accounts')
      .upsert({
        user_id: userId,
        shop_domain: shopDomain,
        access_token: accessToken,
        status: 'connected',
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })

    if (upsertError) {
      console.error('Error saving to database:', upsertError)
      return new Response(JSON.stringify({
        success: false,
        error: 'Error al guardar credenciales. Intenta nuevamente.',
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Shopify account saved successfully for user:', userId)

    return new Response(JSON.stringify({
      success: true,
      shopName,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: 'Error interno del servidor',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
