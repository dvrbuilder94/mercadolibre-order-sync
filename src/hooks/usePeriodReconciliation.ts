import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { PeriodReconciliation } from '@/types/reconciliation';
import { classifyCharge, type ChargeCategory } from '@/lib/meliChargeMap';

const SCORE_OK = 80;

const CHANNEL_LABEL: Record<string, string> = {
  meli: 'MercadoLibre', falabella: 'Falabella', paris: 'Paris',
  ripley: 'Ripley', shopify: 'Shopify', woocommerce: 'WooCommerce',
};
const channelLabel = (id: string) => CHANNEL_LABEL[id] ?? id;

const periodRange = (periodo: string) => {
  const [y, m] = periodo.split('-').map(Number);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to:   new Date(y, m, 0).toISOString().slice(0, 10),
  };
};

type CategorySums = Record<ChargeCategory, number>;
const emptySums = (): CategorySums => ({
  comision_marketplace: 0, costos_envio: 0,
  comision_pago: 0, reembolso: 0, sin_categorizar: 0,
});

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
        const PAGE = 1000;

        // ── 1. Paginate all non-cancelled orders in period ────────────────────
        const rows: any[] = [];
        {
          let offset = 0;
          while (true) {
            let q = supabase
              .from('orders')
              .select(`
                id, gross_amount, net_amount, commission_amount, shipping_cost, financing_fee,
                status, channel, money_release_date, has_exact_data, raw_data,
                order_tax_documents(id),
                meli_payment_details(net_received_amount, total_fees, marketplace_fee, financing_fee, shipping_fee, fee_details)
              `)
              .gte('order_date', from)
              .lte('order_date', to)
              .neq('status', 'cancelled');
            if (canalId !== 'todos') q = q.eq('channel', canalId);
            const { data: batch, error: e } = await q.range(offset, offset + PAGE - 1);
            if (e) throw e;
            rows.push(...(batch ?? []));
            if ((batch ?? []).length < PAGE) break;
            offset += PAGE;
          }
        }
        if (cancelled) return;

        // ── 2. All-channels breakdown for the canal selector ──────────────────
        const allRows: any[] = [];
        {
          let offset = 0;
          while (true) {
            const { data: batch, error: e } = await supabase
              .from('orders')
              .select('channel, gross_amount')
              .gte('order_date', from)
              .lte('order_date', to)
              .neq('status', 'cancelled')
              .range(offset, offset + PAGE - 1);
            if (e) throw e;
            allRows.push(...(batch ?? []));
            if ((batch ?? []).length < PAGE) break;
            offset += PAGE;
          }
        }

        // ── 3. Canal selector data ────────────────────────────────────────────
        const channelMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of allRows) {
          const ch = (r.channel as string) ?? 'desconocido';
          const cur = channelMap.get(ch) ?? { ordenes: 0, monto: 0 };
          channelMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }
        const canales = [
          { id: 'todos', nombre: 'Todos', ordenes: allRows.length },
          ...Array.from(channelMap.entries()).map(([id, v]) => ({
            id, nombre: channelLabel(id), ordenes: v.ordenes,
          })),
        ];

        // ── 4. Ingresos ───────────────────────────────────────────────────────
        const ventasBrutas = rows.reduce((s, r) => s + (r.gross_amount ?? 0), 0);
        const porCanalMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of rows) {
          const ch = (r.channel as string) ?? 'desconocido';
          const cur = porCanalMap.get(ch) ?? { ordenes: 0, monto: 0 };
          porCanalMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }
        const porCanal = Array.from(porCanalMap.entries()).map(([ch, v]) => ({
          canalId: ch, nombre: channelLabel(ch), ordenes: v.ordenes, monto: v.monto,
        }));

        const conDteCount = rows.filter(r => ((r.order_tax_documents as any[]) ?? []).length > 0).length;
        const conDte = {
          pct:    rows.length > 0 ? Math.round((conDteCount / rows.length) * 100) : 0,
          faltan: rows.length - conDteCount,
        };

        // ── 5. Egresos ────────────────────────────────────────────────────────
        const sums = emptySums();
        let exactCount = 0;

        for (const r of rows) {
          const details = (r.meli_payment_details as any[]) ?? [];
          if (details.length > 0) {
            // EXACT: real MercadoPago fee breakdown via meliChargeMap
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
            // FALLBACK: approximate columns from sync-meli-orders.
            // Only commission + shipping are reliable here.
            // financing_fee is set to totalFees by sync-meli-payment-details
            // which would double-count — skip it in fallback.
            sums.comision_marketplace += Math.abs(r.commission_amount ?? 0);
            sums.costos_envio         += Math.abs(r.shipping_cost ?? 0);
          }
        }

        // Devoluciones: cancelled/returned orders (excluded from main rows)
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

        const datosExactos = {
          ordenes: exactCount,
          total:   rows.length,
          pct:     rows.length > 0 ? Math.round((exactCount / rows.length) * 100) : 0,
        };

        // TODO: comisionMarketplace.conFactura — facturas de comisión de MeLi no disponibles aún
        const comisionConFactura = { pct: 0, faltan: rows.length };

        // ── 6. Líquido ────────────────────────────────────────────────────────
        const liquidoRecibido =
          ventasBrutas - sums.comision_marketplace - sums.costos_envio - sums.comision_pago - devolucionMonto;

        // ── 7. Abonos banco (filtrado por canal) ──────────────────────────────
        let bankQuery = supabase
          .from('bank_movements')
          .select('amount')
          .gte('movement_date', from)
          .lte('movement_date', to);
        if (canalId !== 'todos') bankQuery = (bankQuery as any).eq('source_channel', canalId);
        const { data: bankRows } = await bankQuery;
        const abonosBanco = (bankRows ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
        const diferencia  = liquidoRecibido - abonosBanco;

        // ── 8. Excepciones ────────────────────────────────────────────────────
        const hoy = new Date();
        const pagosAtascados = rows.filter(r =>
          r.money_release_date && new Date(r.money_release_date) < hoy && !r.has_exact_data
        ).length;
        const scoreBajo = rows.filter(r => {
          const score = (r.raw_data as any)?.score;
          return score != null && score < SCORE_OK;
        }).length;

        const excepciones: PeriodReconciliation['excepciones'] = [
          { tipo: 'venta_sin_dte',     label: 'Ventas sin boleta/factura',          count: conDte.faltan,    severidad: conDte.faltan > 0 ? 'danger' : 'warning' },
          { tipo: 'pago_atascado',     label: 'Pagos sin confirmar (faltan datos)', count: pagosAtascados,   severidad: 'warning' },
          { tipo: 'devolucion_sin_nc', label: 'Devoluciones sin nota de crédito',   count: devTotal - devConNC, severidad: (devTotal - devConNC) > 0 ? 'danger' : 'warning' },
          { tipo: 'score_bajo',        label: 'Coincidencias de baja confianza',    count: scoreBajo,         severidad: 'warning' },
        ];

        // ── 9. Cierre ─────────────────────────────────────────────────────────
        const { data: closing } = await supabase
          .from('monthly_closings').select('status').eq('period', periodo).maybeSingle();
        const estadoCierre = closing?.status === 'closed' || closing?.status === 'closed_with_observations'
          ? 'cerrado' : 'abierto';
        const bloqueadores = excepciones.filter(e => e.severidad === 'danger' && e.count > 0).length;

        if (!cancelled) {
          setData({
            periodo, canalId, canales,
            ingresos: { ventasBrutas, porCanal, conDte },
            egresos: {
              comisionMarketplace: { monto: sums.comision_marketplace, conFactura: comisionConFactura },
              costosEnvio:         { monto: sums.costos_envio },
              comisionPago:        { monto: sums.comision_pago },
              reembolsos:          { monto: devolucionMonto, conNotaCredito: { con: devConNC, total: devTotal } },
            },
            liquidoRecibido, abonosBanco, diferencia, datosExactos, excepciones,
            cierre: { estado: estadoCierre, bloqueadores, puedeCerrar: bloqueadores === 0 },
          });
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Error desconocido'); setLoading(false); }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [canalId, periodo]);

  return { data, loading, error };
}
