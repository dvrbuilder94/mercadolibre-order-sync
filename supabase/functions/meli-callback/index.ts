import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jwtVerify } from 'https://esm.sh/jose@5.2.0';
import { getMeliAccount } from '../_shared/meli-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { code, state } = await req.json();

    if (!code) {
      return new Response(
        JSON.stringify({ error: 'Authorization code is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!state) {
      return new Response(
        JSON.stringify({ error: 'State parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify state token. account_id (if present) was embedded by
    // get-meli-auth-url and identifies which store this callback belongs to —
    // it travels through the signed JWT rather than a client-supplied body
    // field, so it can't be spoofed to overwrite a different store's tokens.
    let accountId: string | null = null;
    try {
      const jwtSecret = new TextEncoder().encode(
        Deno.env.get('SUPABASE_JWT_SECRET') || Deno.env.get('SUPABASE_ANON_KEY') || ''
      );

      const { payload } = await jwtVerify(state, jwtSecret);

      if (payload.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: 'Invalid state token' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      accountId = typeof payload.account_id === 'string' ? payload.account_id : null;
    } catch (error) {
      console.error('Error verifying state token:', error);
      return new Response(
        JSON.stringify({ error: 'Invalid or expired state token' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get user's Mercado Libre account configuration
    const { data: meliAccount, error: accountError } = await getMeliAccount(supabaseClient, user.id, {
      accountId,
    });

    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ error: 'No Mercado Libre account configured' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: meliAccount.client_id,
        client_secret: meliAccount.client_secret,
        code: code,
        redirect_uri: meliAccount.redirect_uri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error('Error exchanging code for token:', errorData);
      return new Response(
        JSON.stringify({ error: 'Failed to exchange authorization code' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tokenData = await tokenResponse.json();

    // Get user info to get seller_id
    const userInfoResponse = await fetch('https://api.mercadolibre.com/users/me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const userInfo = await userInfoResponse.json();

    // Calculate token expiration
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    console.log('=== MELI AUTHENTICATION DEBUG ===');
    console.log('User ID:', user.id);
    console.log('Token Data:', {
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      access_token_preview: tokenData.access_token?.substring(0, 20) + '...',
      refresh_token_preview: tokenData.refresh_token?.substring(0, 20) + '...',
    });
    console.log('User Info from MELI API:', {
      id: userInfo.id,
      nickname: userInfo.nickname,
      email: userInfo.email,
      site_id: userInfo.site_id,
      user_type: userInfo.user_type,
      country_id: userInfo.country_id,
    });
    console.log('Expires At:', expiresAt.toISOString());

    // Update account with tokens
    const { error: updateError } = await supabaseClient
      .from('meli_accounts')
      .update({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt.toISOString(),
        seller_id: userInfo.id.toString(),
      })
      .eq('id', meliAccount.id);

    if (updateError) {
      console.error('Error updating account:', updateError);
      return new Response(
        JSON.stringify({ error: 'Failed to save tokens' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify what was saved in database
    const { data: savedAccount, error: fetchError } = await supabaseClient
      .from('meli_accounts')
      .select('*')
      .eq('id', meliAccount.id)
      .single();
    
    if (!fetchError && savedAccount) {
      console.log('Verified Saved Account in DB:', {
        id: savedAccount.id,
        user_id: savedAccount.user_id,
        seller_id: savedAccount.seller_id,
        client_id: savedAccount.client_id,
        site_id: savedAccount.site_id,
        has_access_token: !!savedAccount.access_token,
        has_refresh_token: !!savedAccount.refresh_token,
        expires_at: savedAccount.expires_at,
        created_at: savedAccount.created_at,
        updated_at: savedAccount.updated_at,
      });
    } else if (fetchError) {
      console.error('Error fetching saved account:', fetchError);
    }

    console.log('Successfully authenticated user:', user.id);
    console.log('=== END DEBUG ===');

    return new Response(
      JSON.stringify({ success: true, seller_id: userInfo.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in callback:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
