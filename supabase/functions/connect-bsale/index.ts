import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { orgAdminErrorStatus, requireOrgAdmin } from '../_shared/org-admin.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    let adminContext
    try {
      adminContext = await requireOrgAdmin(supabase, req.headers.get('Authorization'))
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: 'No autorizado para administrar conexiones' }), {
        status: orgAdminErrorStatus(error),
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json().catch(() => ({}))
    const { accessToken } = body
    if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Access token es requerido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const trimmedToken = accessToken.trim()
    const bsaleResponse = await fetch('https://api.bsale.io/v1/users.json', {
      method: 'GET',
      headers: { access_token: trimmedToken, 'Content-Type': 'application/json' },
    })

    if (!bsaleResponse.ok) {
      if (bsaleResponse.status === 401 || bsaleResponse.status === 403) {
        return new Response(JSON.stringify({ success: false, error: 'Token inválido o sin permisos. Verifica que el token sea correcto.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: false, error: 'Error al validar token con Bsale. Intenta nuevamente.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const bsaleData = await bsaleResponse.json()
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

    if (!cpnId) {
      const companiesResponse = await fetch('https://api.bsale.io/v1/companies.json', {
        method: 'GET',
        headers: { access_token: trimmedToken, 'Content-Type': 'application/json' },
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
      return new Response(JSON.stringify({ success: false, error: 'El token es válido, pero Bsale no informó el ID de empresa necesario para configurar los webhooks.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const webhookUrl = `${supabaseUrl}/functions/v1/bsale-webhook`
    const { error: upsertError } = await supabase
      .from('bsale_accounts')
      .upsert({
        user_id: adminContext.ownerUserId,
        organization_id: adminContext.organizationId,
        access_token: trimmedToken,
        cpn_id: cpnId,
        client_name: companyName,
        webhook_url: webhookUrl,
        status: 'connected',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

    if (upsertError) {
      console.error('Error saving Bsale account:', upsertError)
      return new Response(JSON.stringify({ success: false, error: 'Error al guardar credenciales. Intenta nuevamente.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true, companyName: companyName || cpnId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({ success: false, error: 'Error interno del servidor' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
