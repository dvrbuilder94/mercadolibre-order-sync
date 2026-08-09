import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { MP_API, mpAppCredentials } from '../_shared/mercadopago-account.ts';

// Paso 2 del OAuth: Mercado Pago redirige aquí con ?code&state. Validamos el
// state, canjeamos el código por tokens y devolvemos al usuario a la app.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const appUrl = Deno.env.get('APP_URL') ?? url.origin;
  const back = (params: Record<string, string>) =>
    Response.redirect(`${appUrl}/mercadopago/callback?${new URLSearchParams(params)}`, 302);

  try {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const mpError = url.searchParams.get('error');

    if (mpError) return back({ status: 'error', message: 'Autorización cancelada en Mercado Pago' });
    if (!code || !state) return back({ status: 'error', message: 'Respuesta incompleta de Mercado Pago' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: stateRow, error: stateError } = await supabase
      .from('mercadopago_oauth_states')
      .select('state, user_id, code_verifier, redirect_uri, expires_at')
      .eq('state', state)
      .maybeSingle();

    if (stateError || !stateRow) {
      return back({ status: 'error', message: 'Solicitud de autorización inválida' });
    }
    if (new Date(stateRow.expires_at).getTime() < Date.now()) {
      await supabase.from('mercadopago_oauth_states').delete().eq('state', state);
      return back({ status: 'error', message: 'La autorización expiró. Intentá de nuevo.' });
    }

    const { clientId, clientSecret } = mpAppCredentials();
    const tokenResponse = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: stateRow.redirect_uri,
        code_verifier: stateRow.code_verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      console.error('MP token exchange falló:', tokenResponse.status, detail);
      return back({ status: 'error', message: 'No se pudo completar la conexión con Mercado Pago' });
    }

    const token = await tokenResponse.json();
    const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 21600) * 1000).toISOString();

    let nickname: string | null = null;
    let email: string | null = null;
    let siteId: string | null = null;
    const meResponse = await fetch(`${MP_API}/users/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (meResponse.ok) {
      const me = await meResponse.json();
      nickname = me.nickname ?? null;
      email = me.email ?? null;
      siteId = me.site_id ?? null;
    }

    const { error: upsertError } = await supabase
      .from('mercadopago_accounts')
      .upsert({
        user_id: stateRow.user_id,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? null,
        expires_at: expiresAt,
        scope: token.scope ?? null,
        public_key: token.public_key ?? null,
        mp_user_id: String(token.user_id),
        nickname,
        email,
        site_id: siteId,
        status: 'connected',
        connection_method: 'oauth',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,mp_user_id' });

    if (upsertError) {
      console.error('Error guardando cuenta MP:', upsertError);
      return back({ status: 'error', message: 'No se pudo guardar la conexión' });
    }

    await supabase.from('mercadopago_oauth_states').delete().eq('state', state);
    return back({ status: 'success', nickname: nickname ?? '' });
  } catch (error) {
    console.error('mercadopago-callback error:', error);
    return back({ status: 'error', message: 'Error interno al conectar Mercado Pago' });
  }
});
