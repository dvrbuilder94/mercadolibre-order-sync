import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    console.log('=== PIPELINE DIAGNOSTIC ===');
    console.log('User:', user.id);

    // ── 1. ORDERS ──
    const { data: orders, count: totalOrders } = await supabaseAdmin
      .from('orders')
      .select('id, order_id, status, money_release_date, channel', { count: 'exact' })
      .limit(5000);

    const ordersAll = orders || [];
    const ordersWithPayment = ordersAll.filter(o => o.money_release_date !== null);
    const ordersWithoutPayment = ordersAll.filter(o => o.money_release_date === null);
    const ordersCancelled = ordersAll.filter(o => o.status === 'cancelled');

    // ── 2. TAX DOCUMENTS ──
    const { data: docs, count: totalDocs } = await supabaseAdmin
      .from('tax_documents')
      .select('id, document_type, status, sales_channel, detected_channel, external_order_id, raw_data', { count: 'exact' })
      .eq('status', 'issued')
      .limit(5000);

    const docsAll = docs || [];
    const docsWithExternalOrderId = docsAll.filter(d => d.external_order_id !== null);
    const docsWithoutExternalOrderId = docsAll.filter(d => d.external_order_id === null);
    const docsWithDetectedChannel = docsAll.filter(d => d.detected_channel !== null);
    const docsWithNullChannel = docsAll.filter(d => d.detected_channel === null);

    // Count by document type
    const docsByType: Record<string, number> = {};
    docsAll.forEach(d => { docsByType[d.document_type] = (docsByType[d.document_type] || 0) + 1; });

    // Count by detected channel
    const docsByChannel: Record<string, number> = {};
    docsAll.forEach(d => {
      const ch = d.detected_channel || 'sin_canal';
      docsByChannel[ch] = (docsByChannel[ch] || 0) + 1;
    });

    // ── 3. LINKS (order_tax_documents) ──
    const { data: links, count: totalLinks } = await supabaseAdmin
      .from('order_tax_documents')
      .select('id, order_id, tax_document_id, match_source, match_score', { count: 'exact' })
      .limit(10000);

    const linksAll = links || [];
    const linkedOrderIds = new Set(linksAll.map(l => l.order_id));
    const linkedDocIds = new Set(linksAll.map(l => l.tax_document_id));

    const linksBySource: Record<string, number> = {};
    linksAll.forEach(l => {
      const src = l.match_source || 'unknown';
      linksBySource[src] = (linksBySource[src] || 0) + 1;
    });

    // ── 4. CROSS-REFERENCE: Orders with/without linked doc ──
    const ordersNeedingDoc = ordersWithPayment.filter(o => !linkedOrderIds.has(o.id) && o.status !== 'cancelled');
    const ordersLinked = ordersWithPayment.filter(o => linkedOrderIds.has(o.id));
    const docsUnlinked = docsAll.filter(d => !linkedDocIds.has(d.id));
    const docsLinked = docsAll.filter(d => linkedDocIds.has(d.id));

    // ── 5. PHASE 0 POTENTIAL: docs with external_order_id that COULD match an order ──
    const orderIdSet = new Set(ordersAll.map(o => String(o.order_id)));
    const docsReadyForPhase0 = docsWithExternalOrderId.filter(d => {
      const eoi = String(d.external_order_id || '');
      return orderIdSet.has(eoi) && !linkedDocIds.has(d.id);
    });

    // ── 6. SAMPLE: first 5 unlinked docs with external_order_id to debug ──
    const sampleUnlinkedWithEOI = docsWithExternalOrderId
      .filter(d => !linkedDocIds.has(d.id))
      .slice(0, 5)
      .map(d => ({
        doc_id: d.id,
        external_order_id: d.external_order_id,
        document_type: d.document_type,
        detected_channel: d.detected_channel,
        order_exists_in_db: orderIdSet.has(String(d.external_order_id)),
      }));

    // ── 7. SAMPLE: first 5 orders without money_release_date ──
    const sampleOrdersNoPayment = ordersWithoutPayment.slice(0, 5).map(o => ({
      order_id: o.order_id,
      status: o.status,
      channel: o.channel,
    }));

    const report = {
      generated_at: new Date().toISOString(),

      orders: {
        total: totalOrders || ordersAll.length,
        with_payment_date: ordersWithPayment.length,
        without_payment_date: ordersWithoutPayment.length,
        cancelled: ordersCancelled.length,
        linked_to_doc: ordersLinked.length,
        needing_doc: ordersNeedingDoc.length,
        sample_no_payment: sampleOrdersNoPayment,
      },

      tax_documents: {
        total_issued: docsAll.length,
        by_type: docsByType,
        by_channel: docsByChannel,
        with_external_order_id: docsWithExternalOrderId.length,
        without_external_order_id: docsWithoutExternalOrderId.length,
        with_detected_channel: docsWithDetectedChannel.length,
        without_detected_channel: docsWithNullChannel.length,
        linked: docsLinked.length,
        unlinked: docsUnlinked.length,
      },

      links: {
        total: totalLinks || linksAll.length,
        by_source: linksBySource,
      },

      phase0_analysis: {
        docs_with_external_order_id: docsWithExternalOrderId.length,
        docs_matching_an_order: docsReadyForPhase0.length,
        sample: sampleUnlinkedWithEOI,
        note: docsReadyForPhase0.length > 0
          ? `⚠️ Hay ${docsReadyForPhase0.length} docs con external_order_id que coincide con una orden pero NO están vinculados. El auto-reconcile debería haberlos unido.`
          : docsWithExternalOrderId.length === 0
          ? '❌ Ningún documento tiene external_order_id guardado. El número de orden ML no se está extrayendo de las referencias de Bsale.'
          : '✅ Todos los docs con external_order_id ya están vinculados.',
      },

      problems_detected: [] as string[],
      recommendations: [] as string[],
    };

    // Auto-detect problems
    if (ordersWithoutPayment.length > ordersWithPayment.length * 0.3) {
      report.problems_detected.push(`${ordersWithoutPayment.length} órdenes sin money_release_date — excluidas del auto-reconcile`);
      report.recommendations.push('Ejecutar sync-meli-payment-details para obtener fechas de pago exactas');
    }

    if (docsWithExternalOrderId.length === 0 && docsAll.length > 0) {
      report.problems_detected.push('Ningún documento tiene external_order_id — el número de orden ML no se extrae de referencias Bsale');
      report.recommendations.push('Verificar que referencias de Bsale contienen el número de orden ML (ej: "200013409796941")');
    }

    if (docsReadyForPhase0.length > 0) {
      report.problems_detected.push(`${docsReadyForPhase0.length} docs con external_order_id válido pero sin vincular — auto-reconcile Phase 0 no los procesó`);
      report.recommendations.push('Ejecutar auto-reconcile de nuevo — los docs deben vincularse via Phase 0 (hard match)');
    }

    if (docsWithNullChannel.length > 0) {
      report.problems_detected.push(`${docsWithNullChannel.length} documentos sin detected_channel — no se muestra canal en la UI`);
      report.recommendations.push('Usar el botón "Corregir B2B" y re-sincronizar Bsale para recalcular canales');
    }

    if (ordersNeedingDoc.length > 0 && docsUnlinked.length === 0) {
      report.problems_detected.push('Hay órdenes sin documento pero NO hay documentos sin vincular — faltan boletas en Bsale');
    }

    console.log('Diagnostic complete:', JSON.stringify(report, null, 2));

    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Diagnostic error:', error);
    return new Response(JSON.stringify({ error: error?.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
