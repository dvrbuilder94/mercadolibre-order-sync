import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveUserId } from '../_shared/auth.ts';
import {
  MP_API, getMercadoPagoAccount, getFreshMercadoPagoToken,
} from '../_shared/mercadopago-account.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const split = (line: string) =>
    line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? '']));
  });
}

const num = (value: string | undefined) => {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// Reporte oficial de liquidaciones (release report): es el único origen que
// cuadra peso a peso lo que Mercado Pago depositó en el banco.
// Solo lectura: listamos y descargamos reportes ya generados en el panel de MP.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    );
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { account_id, user_id: userIdParam, max_reports = 3 } =
      await req.json().catch(() => ({}));

    const userId = await resolveUserId(req, supabase, userIdParam);
    if (!userId) return json({ success: false, error: 'No autorizado' }, 401);

    const account = await getMercadoPagoAccount(admin, userId, account_id);
    if (!account) {
      return json({ success: false, error: 'No hay cuenta de Mercado Pago conectada' }, 400);
    }
    const accessToken = await getFreshMercadoPagoToken(admin, account);
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const listResponse = await fetch(`${MP_API}/v1/account/release_report/list`, {
      headers: authHeaders,
    });
    if (!listResponse.ok) {
      const detail = await listResponse.text().catch(() => '');
      return json({
        success: false,
        error: listResponse.status === 404
          ? 'No hay reportes de liquidación disponibles. Generá uno desde el panel de Mercado Pago (Informes → Liberaciones).'
          : `Mercado Pago rechazó la consulta de reportes (${listResponse.status}): ${detail}`,
      }, 400);
    }

    const available: any[] = await listResponse.json();
    const reports = (Array.isArray(available) ? available : [])
      .sort((a, b) => String(b.file_name).localeCompare(String(a.file_name)))
      .slice(0, Number(max_reports));

    let movementsIngested = 0;
    const processed: string[] = [];

    for (const report of reports) {
      const fileName = report.file_name;
      if (!fileName) continue;

      const fileResponse = await fetch(`${MP_API}/v1/account/release_report/${fileName}`, {
        headers: authHeaders,
      });
      if (!fileResponse.ok) {
        console.error('No se pudo descargar el reporte', fileName, fileResponse.status);
        continue;
      }

      const rows = parseCsv(await fileResponse.text());
      // Solo las liberaciones a cuenta bancaria (payout) son movimientos de banco.
      const payouts = rows.filter((row) =>
        String(row['DESCRIPTION'] ?? row['description'] ?? '').toLowerCase().includes('payout')
        || String(row['TRANSACTION_TYPE'] ?? row['transaction_type'] ?? '').toLowerCase().includes('payout'));

      const movements = payouts.map((row) => {
        const externalId = row['SOURCE_ID'] || row['source_id'] || row['EXTERNAL_REFERENCE'] || fileName;
        const amount = num(row['NET_CREDIT_AMOUNT'] || row['net_credit_amount'])
          - num(row['NET_DEBIT_AMOUNT'] || row['net_debit_amount']);
        const date = row['SETTLEMENT_DATE'] || row['settlement_date']
          || row['DATE'] || row['date'] || new Date().toISOString();
        return {
          user_id: userId,
          movement_date: new Date(date).toISOString(),
          amount,
          description: `Liquidación Mercado Pago ${externalId}`,
          bank_account: 'Mercado Pago',
          source_channel: 'mercadopago',
          external_reference: `MP-RELEASE-${externalId}`,
          reconciled: false,
          raw_data: { source: 'sync-mercadopago-settlements', file_name: fileName, row },
        };
      }).filter((movement) => movement.amount !== 0);

      for (let i = 0; i < movements.length; i += 200) {
        const { data, error } = await admin
          .from('bank_movements')
          .upsert(movements.slice(i, i + 200), { onConflict: 'external_reference' })
          .select('id');
        if (error) throw error;
        movementsIngested += data?.length ?? 0;
      }
      processed.push(fileName);
    }

    await admin
      .from('mercadopago_accounts')
      .update({ last_settlement_sync_at: new Date().toISOString() })
      .eq('id', account.id);

    return json({
      success: true,
      reportsAvailable: available.length,
      reportsProcessed: processed,
      movementsIngested,
    });
  } catch (error) {
    console.error('sync-mercadopago-settlements error:', error);
    return json({ success: false, error: error instanceof Error ? error.message : 'Error interno' }, 500);
  }
});
