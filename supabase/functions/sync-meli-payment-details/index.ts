import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { getMeliAccount, getFreshAccessToken } from '../_shared/meli-account.ts';
import { resolveUserId } from '../_shared/auth.ts';
import {
  allocatePackPayments,
  type PackOrder,
  type PackPayment,
} from '../_shared/meli-pack-payment-allocation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type OrderRow = {
  id: string;
  order_id: string;
  amount: number | null;
  gross_amount: number | null;
  raw_data: any;
  status?: string | null;
};

type PersistedPayment = {
  externalId: string;
  rowId: string;
  gross: number;
  net: number;
  fees: number;
  releaseDate: string | null;
};

const orderGross = (order: OrderRow) => Number(order.gross_amount ?? order.amount ?? 0);
const orderPaymentIds = (order: OrderRow) =>
  (Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [])
    .map((payment: any) => payment?.id)
    .filter(Boolean)
    .map((id: any) => String(id));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    );

    const {
      date_from,
      date_to,
      days_back,
      limit = 50,
      account_id: accountIdParam,
      user_id: userIdParam,
    } = await req.json().catch(() => ({}));
    const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 100));

    const userId = await resolveUserId(req, supabase, userIdParam);
    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autorizado. Por favor, recarga la página e inicia sesión nuevamente.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: meliAccount, error: accountError } = await getMeliAccount(supabase, userId, {
      accountId: accountIdParam,
      orderBy: 'created_at',
      maybeSingle: true,
    });
    if (accountError || !meliAccount) {
      return new Response(
        JSON.stringify({ success: false, error: 'No se encontró cuenta de MercadoLibre conectada' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const accessToken = await getFreshAccessToken(supabase, meliAccount);

    let ordersQuery = supabase
      .from('orders')
      .select('id, order_id, amount, gross_amount, raw_data, status')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('has_exact_data', false)
      .order('order_date', { ascending: false })
      .limit(effectiveLimit);

    if (date_from && date_to) {
      ordersQuery = ordersQuery.gte('order_date', date_from).lte('order_date', date_to);
    } else if (days_back) {
      const cutoffDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
      ordersQuery = ordersQuery.gte('order_date', cutoffDate);
    }

    const { data: pendingOrders, error: ordersError } = await ordersQuery;
    if (ordersError) throw ordersError;

    const seeds = (pendingOrders || []) as OrderRow[];
    if (seeds.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, updated: 0, skipped: 0, errors: 0, unresolvedPayments: 0, message: 'No hay órdenes pendientes de sincronizar' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let paymentsLinked = 0;
    let unresolvedPayments = 0;
    const processedGroups = new Set<string>();

    for (const seed of seeds) {
      const packId = seed.raw_data?.pack_id != null ? String(seed.raw_data.pack_id) : null;
      const groupKey = packId ? `pack:${packId}` : `order:${seed.id}`;
      if (processedGroups.has(groupKey)) continue;
      processedGroups.add(groupKey);

      let group: OrderRow[] = [seed];
      if (packId) {
        const { data: siblings, error: siblingsError } = await supabase
          .from('orders')
          .select('id, order_id, amount, gross_amount, raw_data, status')
          .eq('channel', 'meli')
          .eq('channel_account_id', meliAccount.id)
          .eq('raw_data->>pack_id', packId);
        if (siblingsError) {
          console.error(`Error fetching pack ${packId}:`, siblingsError);
          errors++;
          continue;
        }
        group = ((siblings || []) as OrderRow[]).filter((order) =>
          !['cancelled', 'rejected', 'invalid'].includes(String(order.status || '').toLowerCase()),
        );
      }

      processed += group.length;
      const uniquePaymentIds = Array.from(new Set(group.flatMap(orderPaymentIds)));
      if (uniquePaymentIds.length === 0) {
        skipped += group.length;
        continue;
      }

      const persisted = new Map<string, PersistedPayment>();
      const packPayments: PackPayment[] = [];

      for (const paymentId of uniquePaymentIds) {
        try {
          const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          });
          if (response.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            errors++;
            continue;
          }
          if (!response.ok) {
            console.error(`Error fetching payment ${paymentId}: ${response.status}`);
            errors++;
            continue;
          }

          const details = await response.json();
          const gross = Number(details.transaction_amount || 0);
          const net = Number(details.net_received_amount || details.transaction_details?.net_received_amount || 0);
          const feeDetails: any[] = Array.isArray(details.fee_details) ? details.fee_details : [];
          const fees = feeDetails.length > 0
            ? feeDetails.reduce((sum: number, fee: any) => sum + Number(fee.amount || 0), 0)
            : gross - net;
          const releaseDate = details.money_release_date || details.date_approved || null;
          const explicitOwners = group.filter((order) => orderPaymentIds(order).includes(paymentId));
          const auditOwner = explicitOwners.length === 1 ? explicitOwners[0] : seed;

          const { error: detailError } = await supabase.from('meli_payment_details').upsert({
            order_id: auditOwner.id,
            payment_id: paymentId,
            transaction_amount: gross,
            net_received_amount: net,
            total_fees: fees,
            marketplace_fee: feeDetails.find((fee: any) => fee.type === 'marketplace_fee')?.amount ?? fees,
            financing_fee: feeDetails.find((fee: any) => fee.type === 'financing_fee')?.amount || 0,
            shipping_fee: feeDetails.find((fee: any) => fee.type === 'shipping_fee')?.amount || 0,
            fee_details: details.fee_details,
            payment_method: details.payment_method_id,
            date_approved: details.date_approved,
            money_release_date: releaseDate,
            status: details.status,
            raw_data: details,
          }, { onConflict: 'payment_id' });
          if (detailError) {
            console.error(`Error saving payment detail ${paymentId}:`, detailError);
            errors++;
          }

          if (details.status !== 'approved' || net <= 0 || gross <= 0) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          }

          const { data: paymentRow, error: paymentError } = await supabase
            .from('payments')
            .upsert({
              user_id: userId,
              payment_provider: 'MERCADOPAGO',
              external_payment_id: paymentId,
              payment_date: details.date_approved || releaseDate || new Date().toISOString(),
              gross_amount: gross,
              net_amount: net,
              fees_amount: fees,
              amount: net,
              // El estado definitivo se fija después de asignar. UNMATCHED es
              // más seguro que fabricar una relación sólo por compartir pack_id.
              status: 'UNMATCHED',
              reference: packId ? `MP ${paymentId} · Pack ${packId}` : `MP ${paymentId} · Orden ${seed.order_id}`,
              raw_data: {
                source: 'sync-meli-payment-details',
                source_order_id: auditOwner.order_id,
                pack_id: packId,
                pack_order_count: group.length,
                money_release_date: releaseDate,
                mp_status: details.status,
                payment_type_id: details.payment_type_id || null,
                payment_method_id: details.payment_method_id || null,
              },
            }, { onConflict: 'external_payment_id' })
            .select('id')
            .single();
          if (paymentError || !paymentRow) {
            console.error(`Error upserting payment ${paymentId}:`, paymentError);
            errors++;
            continue;
          }

          persisted.set(paymentId, { externalId: paymentId, rowId: paymentRow.id, gross, net, fees, releaseDate });
          packPayments.push({ id: paymentId, gross, net, fees });
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          console.error(`Error processing payment ${paymentId}:`, error);
          errors++;
        }
      }

      if (packPayments.length === 0) continue;

      const packOrders: PackOrder[] = group.map((order) => ({
        id: order.id,
        orderId: order.order_id,
        gross: orderGross(order),
        paymentIds: orderPaymentIds(order),
      }));
      const result = allocatePackPayments(packOrders, packPayments);
      unresolvedPayments += result.unresolvedPaymentIds.length;

      const paymentRowIds = Array.from(persisted.values()).map((payment) => payment.rowId);
      if (paymentRowIds.length > 0) {
        // Limpia links antiguos del algoritmo proporcional. Sin este delete,
        // un upsert correcto no elimina las relaciones equivocadas ya persistidas.
        const { error: deleteError } = await supabase
          .from('payment_sales')
          .delete()
          .in('payment_id', paymentRowIds);
        if (deleteError) {
          console.error(`Error clearing stale payment_sales for ${groupKey}:`, deleteError);
          errors++;
          continue;
        }
      }

      const allocationsByOrder = new Map<string, typeof result.allocations>();
      const allocatedPaymentIds = new Set<string>();
      for (const allocation of result.allocations) {
        const payment = persisted.get(allocation.paymentId);
        if (!payment) continue;
        const { error: linkError } = await supabase.from('payment_sales').upsert({
          payment_id: payment.rowId,
          sale_id: allocation.orderId,
          allocated_amount: allocation.netAllocated,
        }, { onConflict: 'payment_id,sale_id' });
        if (linkError) {
          console.error(`Error linking payment ${allocation.paymentId} to order ${allocation.orderId}:`, linkError);
          errors++;
          continue;
        }
        paymentsLinked++;
        allocatedPaymentIds.add(allocation.paymentId);
        const rows = allocationsByOrder.get(allocation.orderId) || [];
        rows.push(allocation);
        allocationsByOrder.set(allocation.orderId, rows);
      }

      for (const payment of persisted.values()) {
        const status = allocatedPaymentIds.has(payment.externalId) ? 'ALLOCATED' : 'UNMATCHED';
        const { error: statusError } = await supabase.from('payments').update({ status }).eq('id', payment.rowId);
        if (statusError) errors++;
      }

      for (const order of group) {
        const allocations = allocationsByOrder.get(order.id) || [];
        if (allocations.length === 0) {
          // Ambiguo: mantener has_exact_data=false. Es preferible una excepción
          // visible a registrar una asignación financiera inventada.
          continue;
        }

        const orderNet = allocations.reduce((sum, allocation) => sum + allocation.netAllocated, 0);
        const orderFees = allocations.reduce((sum, allocation) => sum + allocation.feesAllocated, 0);
        const releases = allocations
          .map((allocation) => persisted.get(allocation.paymentId)?.releaseDate)
          .filter(Boolean) as string[];
        const latestRelease = releases.length > 0
          ? releases.reduce((a, b) => new Date(a) > new Date(b) ? a : b)
          : null;
        const gross = orderGross(order);
        const commissionPercentage = gross > 0 ? (orderFees / gross) * 100 : 0;
        const shippingCost = Number(order.raw_data?.shipping?.cost || 0);
        const shippingMode = order.raw_data?.shipping?.shipping_mode || 'custom';
        const settlementAmount = orderNet - (shippingMode === 'me2' ? shippingCost : 0);

        const { error: updateError } = await supabase.from('orders').update({
          gross_amount: gross,
          net_amount: Math.round(orderNet * 100) / 100,
          commission_amount: Math.round(orderFees * 100) / 100,
          commission_percentage: Math.round(commissionPercentage * 100) / 100,
          expected_payment_date: latestRelease,
          money_release_date: latestRelease,
          settlement_date: latestRelease,
          settlement_amount: Math.round(settlementAmount * 100) / 100,
          financing_fee: Math.round(orderFees * 100) / 100,
          tax_amount: 0,
          has_exact_data: true,
        }).eq('id', order.id);
        if (updateError) {
          console.error(`Error updating order ${order.order_id}:`, updateError);
          errors++;
        } else {
          updated++;
        }
      }
    }

    let remainingQuery = supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccount.id)
      .eq('has_exact_data', false);
    if (date_from && date_to) {
      remainingQuery = remainingQuery.gte('order_date', date_from).lte('order_date', date_to);
    } else if (days_back) {
      const cutoffDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
      remainingQuery = remainingQuery.gte('order_date', cutoffDate);
    }
    const { count: remainingCount } = await remainingQuery;

    if ((remainingCount || 0) > 0 && updated > 0) {
      supabase.functions.invoke('sync-meli-payment-details', {
        body: { date_from, date_to, days_back, limit, account_id: meliAccount.id, user_id: userId },
      }).catch((error) => console.error('Chain invoke failed:', error));
    }

    const successRate = processed > 0 ? (updated / processed) * 100 : 0;
    return new Response(
      JSON.stringify({
        success: true,
        processed,
        updated,
        paymentsLinked,
        unresolvedPayments,
        skipped,
        errors,
        remaining: remainingCount ?? 0,
        successRate: Number(successRate.toFixed(1)),
        message: `Sincronización completada: ${updated}/${processed} órdenes actualizadas; ${unresolvedPayments} payments sin asignación segura`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('Fatal sync-meli-payment-details error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Error desconocido', details: error.stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
