import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  getFreshMercadoPagoToken, type MercadoPagoAccount,
} from '../_shared/mercadopago-account.ts';

// Los tokens de Mercado Pago duran 6 horas y el refresh_token rota en cada uso.
// Este cron los renueva antes de que expiren para que ninguna sync se caiga.
Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const threshold = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: accounts, error } = await admin
    .from('mercadopago_accounts')
    .select('id, user_id, access_token, refresh_token, expires_at, mp_user_id, nickname, site_id')
    .eq('status', 'connected')
    .not('refresh_token', 'is', null)
    .lt('expires_at', threshold);

  if (error) {
    console.error('cron-refresh-mercadopago-tokens error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }

  let refreshed = 0;
  const failures: string[] = [];
  for (const account of (accounts ?? []) as MercadoPagoAccount[]) {
    try {
      await getFreshMercadoPagoToken(admin, { ...account, expires_at: null });
      refreshed++;
    } catch (e) {
      failures.push(account.id);
      console.error('No se pudo renovar la cuenta MP', account.id, e);
    }
  }

  return new Response(
    JSON.stringify({ success: true, checked: accounts?.length ?? 0, refreshed, failures }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
