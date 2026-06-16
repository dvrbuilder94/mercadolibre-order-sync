import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { PeriodReconciliation } from '@/types/reconciliation';

const SCORE_OK = 80;

const CHANNEL_LABEL: Record<string, string> = {
  meli: 'MercadoLibre', falabella: 'Falabella', paris: 'Paris',
  ripley: 'Ripley', shopify: 'Shopify', woocommerce: 'WooCommerce',
};
const channelLabel = (id: string) => CHANNEL_LABEL[id] ?? id;

const periodRange = (periodo: string) => {
  const [y, m] = periodo.split('-').map(Number);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01T00:00:00`,
    to:   new Date(y, m, 0).toISOString().slice(0, 10) + 'T23:59:59',
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
        const PAGE = 1000;

        // ── 1. Paginate all non-cancelled orders in period ────────────────────
        // We read commission_amount (= total fees when has_exact_data=true),
        // shipping_cost, has_exact_data, and the DTE link count.
        // meli_payment_details is NOT embedded here — PostgREST FK not registered,
        // so the embed silently returns []. Use has_exact_data flag instead.
        const rows: any[] = [];
        {
          let offset = 0;
          while (true) {
            let q = supabase
              .from('orders')
              .select(`
                id, gross_amount, net_amount, commission_amount, shipping_cost,
                status, channel, money_release_date, has_exact_data, raw_data,
                order_tax_documents(id)
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

        // ── 2. All-channels breakdown for canal selector ──────────────────────
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

        // ── 3. Canal selector ─────────────────────────────────────────────────
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

        // ── 5. Datos exactos de MercadoPago ──────────────────────────────────
        // has_exact_data=true means sync-meli-payment-details ran for this order.
        // When true: commission_amount = real total fees (marketplace+shipping+financing).
        //            net_amount = real net received.
        // When false: commission_amount = estimated (from sync-meli-orders).
        const exactCount = rows.filter(r => r.has_exact_data).length;
        const datosExactos = {
          ordenes: exactCount,
          total:   rows.length,
          pct:     rows.length > 0 ? Math.round((exactCount / rows.length) * 100) : 0,
        };

        // ── 6. Egresos ────────────────────────────────────────────────────────
        // commission_amount is the single reliable fee column (not financing_fee
        // which Pipeline.tsx previously double-counted).
        // shipping_cost = shipping charged to buyer (not always a seller deduction).
        // comision_pago breakdown requires meli_payment_details embed (pending FK setup).
        const comisionMonto = rows.reduce((s, r) => s + Math.abs(r.commission_amount ?? 0), 0);
        const envioCosto    = rows.reduce((s, r) => s + Math.abs(r.shipping_cost ?? 0), 0);
        // TODO: comision_pago per-order breakdown — needs meli_payment_details FK in schema
        const comisionPagoMonto = 0;

        // Devoluciones
        let devQuery = supabase
          .from('orders')
          .select('gross_amount, order_tax_documents(id)')
          .gte('order_date', from)
          .lte('order_date', to)
          .in('status', ['cancelled', 'returned']);
        if (canalId !== 'todos') devQuery = devQuery.eq('channel', canalId);
        const { data: devRows } = await devQuery;
        const devolucionMonto = (devRows ?? []).reduce((s, r) => s + (r.gross_amount ?? 0), 0);
        const devConNC = (devRows ?? []).filter(r => ((r.order_tax_documents as any[]) ?? []).length > 0).length;
        const devTotal = (devRows ?? []).length;

        // TODO: facturas de comisión de MeLi no disponibles en tax_documents aún
        const comisionConFactura = { pct: 0, faltan: 0 };

        // ── 7. Líquido ────────────────────────────────────────────────────────
        const liquidoRecibido = ventasBrutas - comisionMonto - envioCosto - comisionPagoMonto - devolucionMonto;

        // ── 8. Abonos banco ───────────────────────────────────────────────────
        let bankQuery = supabase
          .from('bank_movements')
          .select('amount')
          .gte('movement_date', from.slice(0, 10))
          .lte('movement_date', to.slice(0, 10));
        if (canalId !== 'todos') bankQuery = (bankQuery as any).eq('source_channel', canalId);
        const { data: bankRows } = await bankQuery;
        const abonosBanco = (bankRows ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
        const diferencia  = liquidoRecibido - abonosBanco;

        // ── 9. Excepciones ────────────────────────────────────────────────────
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

        // ── 10. Cierre ────────────────────────────────────────────────────────
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
              comisionMarketplace: { monto: comisionMonto,      conFactura: comisionConFactura },
              costosEnvio:         { monto: envioCosto },
              comisionPago:        { monto: comisionPagoMonto },
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
