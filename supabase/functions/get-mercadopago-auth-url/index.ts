import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { MP_AUTH, mpAppCredentials } from '../_shared/mercadopago-account.ts';
import { orgAdminErrorStatus, requireOrgAdmin } from '../_shared/org-admin.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let adminContext;
    try {
      adminContext = await requireOrgAdmin(supabase, req.headers.get('Authorization'));
    } catch (error) {
      return json({ error: 'No autorizado para administrar conexiones' }, orgAdminErrorStatus(error));
    }

    const { clientId, redirectUri } = mpAppCredentials();
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = base64url(new Uint8Array(digest));

    const { error: stateError } = await supabase.from('mercadopago_oauth_states').insert({
      state,
      user_id: adminContext.ownerUserId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
    if (stateError) throw stateError;

    await supabase
      .from('mercadopago_oauth_states')
      .delete()
      .lt('expires_at', new Date().toISOString());

    const authUrl = `${MP_AUTH}?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      platform_id: 'mp',
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })}`;

    return json({ authUrl });
  } catch (error) {
    console.error('get-mercadopago-auth-url error:', error);
    return json({ error: error instanceof Error ? error.message : 'Error interno' }, 500);
  }
});
