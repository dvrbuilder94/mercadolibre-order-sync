import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { PeriodReconciliation } from '@/types/reconciliation';

// Orders with a raw_data.payments[0] score below this are flagged as low-confidence.
const SCORE_OK = 80;

// source values that indicate a hard/unreliable match in order_tax_documents
const HARD_SOURCES = new Set([
  'AUTO_HARD_ORDER_ID',
  'AUTO_HARD_PACK_ID',
  'AUTO_CONSOLIDATED',
  'webhook_external_order_id',
  'webhook_fallback_boleta',
]);

const periodRange = (periodo: string) => {
  const [y, m] = periodo.split('-').map(Number);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to:   new Date(y, m, 0).toISOString().slice(0, 10), // last day of month
  };
};

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

        // ── 1. Fetch all non-cancelled orders in the period ───────────────────
        let ordersQuery = supabase
          .from('orders')
          .select(`
            id, gross_amount, net_amount, commission_amount, shipping_cost,
            discount_amount, status, channel, payment_method, installments,
            money_release_date, customer_tax_id, raw_data,
            order_tax_documents(id, match_source)
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

        // ── 2. Canal breakdown (always across all channels for selector) ──────
        const { data: allRows } = await supabase
          .from('orders')
          .select('channel, gross_amount')
          .gte('order_date', from)
          .lte('order_date', to)
          .neq('status', 'cancelled');

        const channelMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of allRows ?? []) {
          const ch = r.channel ?? 'desconocido';
          const cur = channelMap.get(ch) ?? { ordenes: 0, monto: 0 };
          channelMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }

        const canales = [
          { id: 'todos', nombre: 'Todos', ordenes: (allRows ?? []).length },
          ...Array.from(channelMap.entries()).map(([id, v]) => ({
            id,
            nombre: id === 'meli' ? 'MercadoLibre' : id,
            ordenes: v.ordenes,
          })),
        ];

        // ── 3. Ingresos ───────────────────────────────────────────────────────
        const ventasBrutas = rows.reduce((s, r) => s + (r.gross_amount ?? 0), 0);

        const porCanalMap = new Map<string, { ordenes: number; monto: number }>();
        for (const r of rows) {
          const ch = r.channel ?? 'desconocido';
          const cur = porCanalMap.get(ch) ?? { ordenes: 0, monto: 0 };
          porCanalMap.set(ch, { ordenes: cur.ordenes + 1, monto: cur.monto + (r.gross_amount ?? 0) });
        }
        const porCanal = Array.from(porCanalMap.entries()).map(([ch, v]) => ({
          canalId: ch,
          nombre:  ch === 'meli' ? 'MercadoLibre' : ch,
          ordenes: v.ordenes,
          monto:   v.monto,
        }));

        // Orders with at least one linked DTE (boleta/factura, not nota crédito)
        const conDteCount = rows.filter(r => {
          const docs = (r.order_tax_documents as any[]) ?? [];
          return docs.length > 0;
        }).length;
        const conDte = {
          pct:    rows.length > 0 ? Math.round((conDteCount / rows.length) * 100) : 0,
          faltan: rows.length - conDteCount,
        };

        // ── 4. Egresos ────────────────────────────────────────────────────────
        const comisionMonto = rows.reduce((s, r) => s + Math.abs(r.commission_amount ?? 0), 0);
        const envioCosto    = rows.reduce((s, r) => s + Math.abs(r.shipping_cost ?? 0), 0);
        // comision_pago: discount_amount en el raw (financing charges). No direct column → estimate 0.
        // TODO: conectar a backend — sumar fee_details clasificados como comision_pago desde raw_data
        const comisionPagoMonto = 0;

        // Reembolsos: órdenes con status cancelled/returned (already excluded from rows,
        // so we query them separately)
        const { data: devRows } = await supabase
          .from('orders')
          .select('gross_amount, order_tax_documents(id)')
          .gte('order_date', from)
          .lte('order_date', to)
          .in('status', ['cancelled', 'returned']);

        const devolucionMonto = (devRows ?? []).reduce((s, r) => s + (r.gross_amount ?? 0), 0);
        const devConNC = (devRows ?? []).filter(r => ((r.order_tax_documents as any[]) ?? []).length > 0).length;
        const devTotal = (devRows ?? []).length;

        // conFactura for comisionMarketplace:
        // TODO: conectar a backend — necesitamos facturas de comisión de MeLi en tax_documents
        const comisionConFactura = { pct: 0, faltan: rows.length };

        // ── 5. Líquido recibido ───────────────────────────────────────────────
        const liquidoRecibido = ventasBrutas - comisionMonto - envioCosto - comisionPagoMonto - devolucionMonto;

        // ── 6. Abonos banco ───────────────────────────────────────────────────
        // TODO: conectar a backend — bank_movements tabla actualmente vacía
        const { data: bankRows } = await supabase
          .from('bank_movements')
          .select('amount')
          .gte('movement_date', from)
          .lte('movement_date', to);

        const abonosBanco = (bankRows ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
        const diferencia  = liquidoRecibido - abonosBanco;

        // ── 7. Excepciones ────────────────────────────────────────────────────
        const ventaSinDte = conDte.faltan;

        // Pagos atascados: money_release_date en el pasado pero no liberado (estimated)
        const hoy = new Date();
        const pagosAtascados = rows.filter(r => {
          if (!r.money_release_date) return false;
          return new Date(r.money_release_date) < hoy && r.net_amount == null;
        }).length;

        // Devoluciones sin NC
        const devSinNC = devTotal - devConNC;

        // Score bajo: orders where raw_data score < SCORE_OK
        const scoreBajo = rows.filter(r => {
          const score = (r.raw_data as any)?.score;
          return score != null && score < SCORE_OK;
        }).length;

        const excepciones: PeriodReconciliation['excepciones'] = [
          {
            tipo:      'venta_sin_dte',
            label:     'Ventas sin boleta/factura',
            count:     ventaSinDte,
            severidad: ventaSinDte > 0 ? 'danger' : 'warning',
          },
          {
            tipo:      'pago_atascado',
            label:     'Pagos sin liberar vencidos',
            count:     pagosAtascados,
            severidad: pagosAtascados > 0 ? 'warning' : 'warning',
          },
          {
            tipo:      'devolucion_sin_nc',
            label:     'Devoluciones sin nota de crédito',
            count:     devSinNC,
            severidad: devSinNC > 0 ? 'danger' : 'warning',
          },
          {
            tipo:      'score_bajo',
            label:     'Coincidencias de baja confianza',
            count:     scoreBajo,
            severidad: 'warning',
          },
        ];

        // ── 8. Cierre ─────────────────────────────────────────────────────────
        // Check monthly_closings table for existing close status
        const { data: closing } = await supabase
          .from('monthly_closings')
          .select('status')
          .eq('period', periodo)
          .maybeSingle();

        const estadoCierre = closing?.status === 'closed' || closing?.status === 'closed_with_observations'
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
            comisionMarketplace: { monto: comisionMonto, conFactura: comisionConFactura },
            costosEnvio:         { monto: envioCosto },
            comisionPago:        { monto: comisionPagoMonto },
            reembolsos:          { monto: devolucionMonto, conNotaCredito: { con: devConNC, total: devTotal } },
          },

          liquidoRecibido,
          abonosBanco,
          diferencia,

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
