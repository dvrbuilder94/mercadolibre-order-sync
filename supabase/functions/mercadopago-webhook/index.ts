import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  MP_API, getFreshMercadoPagoToken, type MercadoPagoAccount,
} from '../_shared/mercadopago-account.ts';

// Webhook de Mercado Pago: recibe el aviso, consulta el recurso por API (GET)
// y actualiza el pago. Nunca escribe en Mercado Pago.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  try {
    const body = await req.json().catch(() => ({} as any));
    const url = new URL(req.url);
    const topic = body.type || body.topic || url.searchParams.get('topic') || '';
    const resourceId = String(
      body.data?.id ?? body.resource ?? url.searchParams.get('id') ?? '',
    ).replace(/^.*\//, '');

    if (!resourceId) return new Response('ok');

    const userIdFromMp = String(body.user_id ?? '');
    let account: MercadoPagoAccount | null = null;
    if (userIdFromMp) {
      const { data } = await admin
        .from('mercadopago_accounts')
        .select('id, user_id, access_token, refresh_token, expires_at, mp_user_id, nickname, site_id')
        .eq('mp_user_id', userIdFromMp)
        .eq('status', 'connected')
        .maybeSingle();
      account = data as MercadoPagoAccount | null;
    }

    // mp-connect avisa vinculación/desvinculación de cuentas.
    if (topic.includes('mp-connect')) {
      if (account && body.action === 'application.deauthorized') {
        await admin
          .from('mercadopago_accounts')
          .update({ status: 'disconnected', updated_at: new Date().toISOString() })
          .eq('id', account.id);
      }
      return new Response('ok');
    }

    if (!topic.includes('payment') || !account) return new Response('ok');

    const accessToken = await getFreshMercadoPagoToken(admin, account);
    const response = await fetch(`${MP_API}/v1/payments/${resourceId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      console.error('MP webhook: no se pudo leer el pago', resourceId, response.status);
      return new Response('ok');
    }

    const payment = await response.json();
    if (payment.status !== 'approved') return new Response('ok');

    const feeDetails = Array.isArray(payment.fee_details) ? payment.fee_details : [];
    const feesAmount = feeDetails.reduce((sum: number, fee: any) => sum + Number(fee?.amount ?? 0), 0);
    const netAmount = Number(
      payment.net_received_amount ?? payment.transaction_details?.net_received_amount ?? 0,
    );

    const { data: existing } = await admin
      .from('payments')
      .select('status')
      .eq('external_payment_id', String(payment.id))
      .maybeSingle();
    if (existing?.status && existing.status !== 'UNMATCHED') return new Response('ok');

    await admin.from('payments').upsert({
      user_id: account.user_id,
      payment_provider: 'MERCADOPAGO',
      external_payment_id: String(payment.id),
      payment_date: payment.date_approved ?? payment.date_created,
      gross_amount: Number(payment.transaction_amount ?? 0),
      net_amount: netAmount,
      fees_amount: feesAmount,
      amount: netAmount,
      status: 'UNMATCHED',
      reference: `MP ${payment.id}`,
      raw_data: {
        source: 'mercadopago-webhook',
        mp_account_id: account.id,
        charges_details: payment.charges_details ?? null,
        mp_payment: payment,
      },
    }, { onConflict: 'external_payment_id' });

    return new Response('ok');
  } catch (error) {
    console.error('mercadopago-webhook error:', error);
    // Devolvemos 200 igual: Mercado Pago reintenta y no queremos loops.
    return new Response('ok');
  }
});
