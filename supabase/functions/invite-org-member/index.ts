import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anon = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } },
    )
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: { user } } = await anon.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const role = body.role === 'admin' ? 'admin' : body.role === 'viewer' ? 'viewer' : null
    const redirectOrigin = typeof body.redirect_origin === 'string' ? body.redirect_origin.trim() : ''

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Email inválido' }, 400)
    if (!role) return json({ error: 'Rol inválido' }, 400)

    const { data: membership } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return json({ error: 'No autorizado para administrar usuarios' }, 403)
    }

    const { data: existingProfile } = await admin
      .from('profiles')
      .select('id')
      .ilike('email', email)
      .limit(1)
      .maybeSingle()

    if (existingProfile?.id) {
      const { data: existingMembership } = await admin
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', membership.organization_id)
        .eq('user_id', existingProfile.id)
        .maybeSingle()
      if (existingMembership) return json({ error: 'Ese usuario ya pertenece a la organización' }, 409)
    }

    const redirectTo = /^https?:\/\//.test(redirectOrigin)
      ? `${redirectOrigin.replace(/\/$/, '')}/auth?invite=1`
      : undefined

    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    )

    if (inviteError || !inviteData?.user) {
      console.error('Invite error:', inviteError?.message)
      return json({ error: inviteError?.message || 'No se pudo enviar la invitación' }, 400)
    }

    const invitedUserId = inviteData.user.id

    await admin.from('profiles').upsert({ id: invitedUserId, email }, { onConflict: 'id' })

    const { error: memberError } = await admin
      .from('organization_members')
      .upsert({
        organization_id: membership.organization_id,
        user_id: invitedUserId,
        role,
      }, { onConflict: 'organization_id,user_id' })

    if (memberError) {
      console.error('Membership error:', memberError.message)
      return json({ error: 'La invitación se creó pero no se pudo asociar el usuario a la organización' }, 500)
    }

    await admin.from('organization_invitations').upsert({
      organization_id: membership.organization_id,
      email,
      role,
      invited_by: user.id,
      invited_user_id: invitedUserId,
      status: 'pending',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,email' })

    return json({ success: true, email, role })
  } catch (error: any) {
    console.error('invite-org-member unexpected error:', error?.message)
    return json({ error: 'Error interno del servidor' }, 500)
  }
})
