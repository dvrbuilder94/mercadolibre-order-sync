import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { getMeliAccount, getFreshAccessToken } from '../_shared/meli-account.ts';
import { resolveUserId } from '../_shared/auth.ts';
import {
  AllocationOrder,
  AllocationPayment,
  resolvePaymentAllocations,
  validateAllocationInvariants,
  validateGrossOwnership,
} from '../_shared/payment-allocation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

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
        JSON.stringify({ success: false, error: 'No autorizado' }),
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
      .select('id, order_id, amount, raw_data')
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

    const { data: orders, error: ordersError } = await ordersQuery;
    if (ordersError) throw ordersError;

    const totalOrders = orders?.length || 0;
    if (totalOrders === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, updated: 0, skipped: 0, errors: 0, paymentsLinked: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let processed = 0;
    let updated = 0;
    let errors = 0;
    let skipped = 0;
    let paymentsLinked = 0;

    for (const order of orders || []) {
      const declaredPayments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];

      if (declaredPayments.length === 0) {
        skipped++;
        processed++;
        continue;
      }

      const processedPayments: Array<{
        paymentRowId: string;
        externalId: string;
        gross: number;
        net: number;
        fees: number;
        releaseDate: string | null;
      }> = [];

      for (const declaredPayment of declaredPayments) {
        const paymentId = declaredPayment?.id;
        if (!paymentId) continue;

        try {
          const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          });

          if (response.status === 429) {
            errors++;
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }

          if (!response.ok) {
            errors++;
            continue;
          }

          const paymentDetails = await response.json();
          const transactionAmount = Number(paymentDetails.transaction_amount || 0);
          const netReceived = Number(
            paymentDetails.net_received_amount ??
              paymentDetails.transaction_details?.net_received_amount ??
              0,
          );
          const feeDetailsList: any[] = Array.isArray(paymentDetails.fee_details)
            ? paymentDetails.fee_details
            : [];
          const paymentFees = feeDetailsList.length > 0
            ? feeDetailsList.reduce((sum: number, fee: any) => sum + Number(fee.amount || 0), 0)
            : Math.max(0, transactionAmount - netReceived);

          // Only persist provider fields that actually exist. In particular,
          // date_approved is NOT a money release date and total fees are NOT a
          // marketplace fee when Mercado Pago does not identify that fee type.
          const releaseDate = paymentDetails.money_release_date || null;
          const marketplaceFee = feeDetailsList.find((fee: any) => fee.type === 'marketplace_fee')?.amount ?? null;
          const financingFee = feeDetailsList.find((fee: any) => fee.type === 'financing_fee')?.amount ?? null;
          const shippingFee = feeDetailsList.find((fee: any) => fee.type === 'shipping_fee')?.amount ?? null;

          const { error: detailError } = await supabase.from('meli_payment_details').upsert({
            order_id: order.id,
            payment_id: paymentId.toString(),
            transaction_amount: transactionAmount,
            net_received_amount: netReceived,
            total_fees: paymentFees,
            marketplace_fee: marketplaceFee,
            financing_fee: financingFee,
            shipping_fee: shippingFee,
            fee_details: paymentDetails.fee_details ?? null,
            payment_method: paymentDetails.payment_method_id ?? null,
            date_approved: paymentDetails.date_approved ?? null,
            money_release_date: releaseDate,
            status: paymentDetails.status ?? null,
            raw_data: paymentDetails,
          }, { onConflict: 'payment_id' });

          if (detailError) {
            errors++;
            continue;
          }

          // Non-approved payments remain visible in meli_payment_details, but
          // they are not treated as cash truth in the ledger.
          if (paymentDetails.status !== 'approved' || netReceived <= 0) {
            continue;
          }

          const { data: paymentRow, error: paymentUpsertError } = await supabase
            .from('payments')
            .upsert({
              user_id: userId,
              payment_provider: 'MERCADOPAGO',
              external_payment_id: paymentId.toString(),
              payment_date: paymentDetails.date_approved || new Date().toISOString(),
              gross_amount: transactionAmount,
              net_amount: netReceived,
              fees_amount: paymentFees,
              amount: netReceived,
              status: 'ALLOCATED',
              reference: `MP ${paymentId} · Orden ${order.order_id}`,
              raw_data: {
                source: 'sync-meli-payment-details',
                order_id: order.order_id,
                money_release_date: releaseDate,
                mp_status: paymentDetails.status,
              },
            }, { onConflict: 'external_payment_id' })
            .select('id')
            .single();

          if (paymentUpsertError || !paymentRow) {
            errors++;
            continue;
          }

          processedPayments.push({
            paymentRowId: paymentRow.id,
            externalId: paymentId.toString(),
            gross: transactionAmount,
            net: netReceived,
            fees: paymentFees,
            releaseDate,
          });

          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          console.error(`Error processing payment ${paymentId}:`, error);
          errors++;
        }
      }

      if (processedPayments.length > 0) {
        // pack_id can widen the candidate set, but it is never ownership evidence.
        const packId = order.raw_data?.pack_id != null ? String(order.raw_data.pack_id) : null;
        let groupRows: any[] = [{
          id: order.id,
          order_id: order.order_id,
          amount: order.amount,
          gross_amount: order.amount,
          raw_data: order.raw_data,
        }];

        if (packId) {
          const { data: siblings, error: siblingsError } = await supabase
            .from('orders')
            .select('id, order_id, amount, gross_amount, status, raw_data')
            .eq('channel', 'meli')
            .eq('channel_account_id', meliAccount.id)
            .eq('raw_data->>pack_id', packId);

          if (siblingsError) {
            errors++;
          } else {
            const activeSiblings = (siblings || []).filter((sibling: any) => sibling.status !== 'cancelled');
            if (activeSiblings.length > 1) groupRows = activeSiblings;
          }
        }

        const explicitByOrder = new Map<string, Set<string>>();
        for (const row of groupRows) {
          explicitByOrder.set(
            row.id,
            new Set<string>(
              (row.raw_data?.payments || [])
                .map((payment: any) => payment?.id != null ? String(payment.id) : null)
                .filter(Boolean) as string[],
            ),
          );
        }

        const { data: knownDetails, error: detailsError } = await supabase
          .from('meli_payment_details')
          .select('order_id, payment_id')
          .in('order_id', groupRows.map((row: any) => row.id));

        if (detailsError) {
          errors++;
        } else {
          for (const detail of knownDetails || []) {
            if (detail.order_id) explicitByOrder.get(detail.order_id)?.add(String(detail.payment_id));
          }
        }

        const groupOrders: AllocationOrder[] = groupRows.map((row: any) => ({
          id: row.id,
          gross: Number(row.gross_amount ?? row.amount ?? 0),
          explicitPaymentIds: Array.from(explicitByOrder.get(row.id) ?? []),
        }));

        const allocationPayments: AllocationPayment[] = processedPayments.map((payment) => ({
          id: payment.externalId,
          gross: payment.gross,
          net: payment.net,
          fees: payment.fees,
        }));

        const { allocations, unresolved } = resolvePaymentAllocations(allocationPayments, groupOrders);

        for (const unresolvedPayment of unresolved) {
          const row = processedPayments.find((payment) => payment.externalId === unresolvedPayment.paymentId);
          if (!row) continue;
          await supabase.from('payments').update({ status: 'UNMATCHED' }).eq('id', row.paymentRowId);
          await supabase.from('payment_sales').delete().eq('payment_id', row.paymentRowId);
        }

        const rejected = new Set<string>();
        for (const payment of allocationPayments) {
          for (const check of [
            validateAllocationInvariants(payment, allocations),
            validateGrossOwnership(payment, allocations, groupOrders),
          ]) {
            if (!check.ok) {
              rejected.add(payment.id);
              errors++;
            }
          }
        }

        const validAllocations = allocations.filter((allocation) => !rejected.has(allocation.paymentId));

        for (const allocation of validAllocations) {
          const row = processedPayments.find((payment) => payment.externalId === allocation.paymentId)!;
          const { error: linkError } = await supabase.from('payment_sales').upsert(
            {
              payment_id: row.paymentRowId,
              sale_id: allocation.orderId,
              allocated_amount: allocation.allocatedNet,
            },
            { onConflict: 'payment_id,sale_id' },
          );
          if (linkError) errors++;
          else paymentsLinked++;
        }

        for (const row of processedPayments) {
          const keep = validAllocations
            .filter((allocation) => allocation.paymentId === row.externalId)
            .map((allocation) => allocation.orderId);
          if (keep.length === 0) continue;
          const { error: cleanError } = await supabase
            .from('payment_sales')
            .delete()
            .eq('payment_id', row.paymentRowId)
            .not('sale_id', 'in', `(${keep.join(',')})`);
          if (cleanError) errors++;
        }

        // orders keeps only a small compatibility cache of exact MP totals that
        // the current UI still reads. Settlement, tax and financing concepts
        // stay in their real domains instead of being fabricated on the order.
        const perOrder = new Map<string, { net: number; fees: number; releaseDates: string[] }>();
        for (const allocation of validAllocations) {
          const payment = processedPayments.find((row) => row.externalId === allocation.paymentId)!;
          const aggregate = perOrder.get(allocation.orderId) ?? { net: 0, fees: 0, releaseDates: [] };
          aggregate.net += allocation.allocatedNet;
          aggregate.fees += allocation.allocatedFees;
          if (payment.releaseDate) aggregate.releaseDates.push(payment.releaseDate);
          perOrder.set(allocation.orderId, aggregate);
        }

        for (const [orderId, totals] of perOrder) {
          const target = groupOrders.find((candidate) => candidate.id === orderId)!;
          const net = Math.round(totals.net * 100) / 100;
          const fees = Math.round(totals.fees * 100) / 100;
          const feePercentage = target.gross > 0
            ? Math.round((fees / target.gross) * 10000) / 100
            : 0;
          const releaseDate = totals.releaseDates.length > 0
            ? totals.releaseDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
            : null;

          const { error: updateError } = await supabase.from('orders').update({
            gross_amount: target.gross,
            net_amount: net,
            commission_amount: fees,
            commission_percentage: feePercentage,
            money_release_date: releaseDate,
            has_exact_data: true,
          }).eq('id', orderId);

          if (updateError) errors++;
          else if (orderId === order.id) updated++;
        }
      }

      processed++;
    }

    const successRate = processed > 0 ? Number(((updated / processed) * 100).toFixed(1)) : 0;

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
      try {
        supabase.functions.invoke('sync-meli-payment-details', {
          body: {
            date_from,
            date_to,
            days_back,
            limit,
            account_id: meliAccount.id,
            user_id: userId,
          },
        }).catch((error) => console.error('Chain invoke failed:', error));
      } catch (error) {
        console.error('Chain invoke threw:', error);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        updated,
        paymentsLinked,
        skipped,
        errors,
        remaining: remainingCount ?? 0,
        successRate,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('Fatal sync-meli-payment-details error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error?.message || 'Error desconocido' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
