import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { PeriodReconciliation } from '@/types/reconciliation';
import { classifyCharge, type ChargeCategory } from '@/lib/meliChargeMap';

// Orders with a raw_data.payments[0] score below this are flagged as low-confidence.
const SCORE_OK = 80;

// Human labels per marketplace channel. Generic fallback keeps it multimarket:
// any new channel shows its raw id until a label is added here.
const CHANNEL_LABEL: Record<string, string> = {
  meli:        'MercadoLibre',
  falabella:   'Falabella',
  paris:       'Paris',
  ripley:      'Ripley',
  shopify:     'Shopify',
  woocommerce: 'WooCommerce',
};
const channelLabel = (id: string) => CHANNEL_LABEL[id] ?? id;

const periodRange = (periodo: string) => {
  const [y, m] = periodo.split('-').map(Number);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to:   new Date(y, m, 0).toISOString().slice(0, 10), // last day of month
  };
};

type CategorySums = Record<ChargeCategory, number>;
const emptySums = (): CategorySums => ({
  comision_marketplace: 0,
  costos_envio:         0,
  comision_pago:        0,
  reembolso:            0,
  sin_categorizar:      0,
});

// Exact fees from a payment-provider detail row. Prefers the itemized fee_details
// (classified via meliChargeMap → multimarket-ready); falls back to the dedicated
// columns when the provider didn't return a breakdown.
function feesFromDetail(d: any): CategorySums {
  const acc = emptySums();
  const fd = Array.isArray(d?.fee_details) ? d.fee_details : [];
  if (fd.length > 0) {
    for (const f of fd) acc[classifyCharge(f.type)] += Math.abs(Number(f.amount) || 0);
  } else {
    acc.comision_marketplace += Math.abs(Number(d?.marketplace_fee) || 0);
    acc.comision_pago        += Math.abs(Number(d?.financing_fee)   || 0);
    acc.costos_envio         += Math.abs(Number(d?.shipping_fee)     || 0);
  }
  return acc;
}

export function usePeriodReconciliation(canalId: string, periodo: string) {
  const [data, setData]       = useState<PeriodReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const { from, to } = periodRange(periodo);

        // ── 1. Orders in period + embedded EXACT payment details ──────────────
        // meli_payment_details.order_id → orders.id lets PostgREST embed the real
        // MercadoPago numbers (net_received_amount, fee_details) alongside each order.
        let ordersQuery = supabase
          .from('orders')
          .select(`
            id, gross_amount, net_amount, commission_amount, shipping_cost, financing_fee,
            discount_amount, status, channel, payment_method, installments,
            money_release_date, has_exact_data, raw_data,
            order_tax_documents(id),
            meli_payment_details(net_received_amount, total_fees, marketplace_fee, financing_fee, shipping_fee, fee_details)
          `)
          .gte('order_date', from)
          .lte('order_date', to)
          .neq('status', 'cancelled');

        if (canalId !== 'todos') {
          ordersQuery = ordersQuery.eq('channel', canalId);
        }

        const { data: orders, error: ordersErr } = await ordersQuery;
        if (ordersErr) throw ordersErr;
        if (cancelled) return;

        const rows = orders ?? [];

        // ── 2. Canal breakdown across ALL channels (for the global selector) ──
        const { data: allRows } = await supabase
          .from('orders')
          .select('channel, gross_amount')
          .gte('order_date', from)
          .lte('order_date', to)
          .neq('status', 'cancelled');

        const channelMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of allRows ?? []) {
          const ch = (r.channel as string) ?? 'desconocido';
          const cur = channelMap.get(ch) ?? { ordenes: 0, monto: 0 };
          channelMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }

        const canales = [
          { id: 'todos', nombre: 'Todos', ordenes: (allRows ?? []).length },
          ...Array.from(channelMap.entries()).map(([id, v]) => ({
            id,
            nombre: channelLabel(id),
            ordenes: v.ordenes,
          })),
        ];

        // ── 3. Ingresos ───────────────────────────────────────────────────────
        const ventasBrutas = rows.reduce((s, r) => s + (r.gross_amount ?? 0), 0);

        const porCanalMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of rows) {
          const ch = (r.channel as string) ?? 'desconocido';
          const cur = porCanalMap.get(ch) ?? { ordenes: 0, monto: 0 };
          porCanalMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }
        const porCanal = Array.from(porCanalMap.entries()).map(([ch, v]) => ({
          canalId: ch,
          nombre:  channelLabel(ch),
          ordenes: v.ordenes,
          monto:   v.monto,
        }));

        const conDteCount = rows.filter(r => ((r.order_tax_documents as any[]) ?? []).length > 0).length;
        const conDte = {
          pct:    rows.length > 0 ? Math.round((conDteCount / rows.length) * 100) : 0,
          faltan: rows.length - conDteCount,
        };

        // ── 4. Egresos — exactos cuando hay payment details, aprox. si no ─────
        const sums = emptySums();
        let exactCount = 0;

        for (const r of rows) {
          const details = (r.meli_payment_details as any[]) ?? [];
          if (details.length > 0) {
            // EXACT path: real provider numbers, classified via meliChargeMap
            exactCount++;
            for (const d of details) {
              const f = feesFromDetail(d);
              sums.comision_marketplace += f.comision_marketplace;
              sums.costos_envio         += f.costos_envio;
              sums.comision_pago        += f.comision_pago;
              sums.reembolso            += f.reembolso;
              sums.sin_categorizar      += f.sin_categorizar;
            }
          } else {
            // FALLBACK path: approximate columns from sync-meli-orders
            sums.comision_marketplace += Math.abs(r.commission_amount ?? 0);
            sums.costos_envio         += Math.abs(r.shipping_cost ?? 0);
            sums.comision_pago        += Math.abs(r.financing_fee ?? 0);
          }
        }

        // Reembolsos: órdenes devueltas/canceladas (fuera de `rows`), consultadas aparte
        let devQuery = supabase
          .from('orders')
          .select('gross_amount, order_tax_documents(id)')
          .gte('order_date', from)
          .lte('order_date', to)
          .in('status', ['cancelled', 'returned']);
        if (canalId !== 'todos') devQuery = devQuery.eq('channel', canalId);

        const { data: devRows } = await devQuery;
        const devolucionMonto = (devRows ?? []).reduce((s, r) => s + (r.gross_amount ?? 0), 0) + sums.reembolso;
        const devConNC = (devRows ?? []).filter(r => ((r.order_tax_documents as any[]) ?? []).length > 0).length;
        const devTotal = (devRows ?? []).length;

        // Cobertura de datos exactos (traídos del payment provider, no aproximados)
        const datosExactos = {
          ordenes: exactCount,
          total:   rows.length,
          pct:     rows.length > 0 ? Math.round((exactCount / rows.length) * 100) : 0,
        };

        // conFactura de la comisión marketplace: aún no recibimos las facturas de
        // comisión que MeLi emite al seller, así que no podemos respaldarlas.
        // TODO: conectar a backend cuando existan en tax_documents (detected_channel)
        const comisionConFactura = { pct: 0, faltan: rows.length };

        // ── 5. Líquido recibido ───────────────────────────────────────────────
        const liquidoRecibido =
          ventasBrutas - sums.comision_marketplace - sums.costos_envio - sums.comision_pago - devolucionMonto;

        // ── 6. Abonos banco (filtrado por canal — multimarket) ────────────────
        let bankQuery = supabase
          .from('bank_movements')
          .select('amount, source_channel')
          .gte('movement_date', from)
          .lte('movement_date', to);
        if (canalId !== 'todos') bankQuery = bankQuery.eq('source_channel', canalId);

        const { data: bankRows } = await bankQuery;
        const abonosBanco = (bankRows ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
        const diferencia  = liquidoRecibido - abonosBanco;

        // ── 7. Excepciones ────────────────────────────────────────────────────
        const ventaSinDte = conDte.faltan;
        const hoy = new Date();
        const pagosAtascados = rows.filter(r => {
          if (!r.money_release_date) return false;
          return new Date(r.money_release_date) < hoy && !r.has_exact_data;
        }).length;
        const devSinNC = devTotal - devConNC;
        const scoreBajo = rows.filter(r => {
          const score = (r.raw_data as any)?.score;
          return score != null && score < SCORE_OK;
        }).length;

        const excepciones: PeriodReconciliation['excepciones'] = [
          { tipo: 'venta_sin_dte',     label: 'Ventas sin boleta/factura',          count: ventaSinDte,    severidad: ventaSinDte > 0 ? 'danger' : 'warning' },
          { tipo: 'pago_atascado',     label: 'Pagos sin confirmar (faltan datos)', count: pagosAtascados, severidad: 'warning' },
          { tipo: 'devolucion_sin_nc', label: 'Devoluciones sin nota de crédito',   count: devSinNC,       severidad: devSinNC > 0 ? 'danger' : 'warning' },
          { tipo: 'score_bajo',        label: 'Coincidencias de baja confianza',    count: scoreBajo,      severidad: 'warning' },
        ];

        // ── 8. Cierre ─────────────────────────────────────────────────────────
        const { data: closing } = await supabase
          .from('monthly_closings')
          .select('status')
          .eq('period', periodo)
          .maybeSingle();

        const estadoCierre =
          closing?.status === 'closed' || closing?.status === 'closed_with_observations'
            ? 'cerrado'
            : 'abierto';

        const bloqueadores = excepciones.filter(e => e.severidad === 'danger' && e.count > 0).length;

        const result: PeriodReconciliation = {
          periodo,
          canalId,
          canales,

          ingresos: {
            ventasBrutas,
            porCanal,
            conDte,
          },

          egresos: {
            comisionMarketplace: { monto: sums.comision_marketplace, conFactura: comisionConFactura },
            costosEnvio:         { monto: sums.costos_envio },
            comisionPago:        { monto: sums.comision_pago },
            reembolsos:          { monto: devolucionMonto, conNotaCredito: { con: devConNC, total: devTotal } },
          },

          liquidoRecibido,
          abonosBanco,
          diferencia,

          datosExactos,

          excepciones,

          cierre: {
            estado:      estadoCierre,
            bloqueadores,
            puedeCerrar: bloqueadores === 0,
          },
        };

        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? 'Error desconocido');
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [canalId, periodo]);

  return { data, loading, error };
}
