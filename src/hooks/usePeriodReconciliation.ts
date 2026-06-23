import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { PeriodReconciliation } from '@/types/reconciliation';
import { SCORE_OK, HARD_MATCH_SOURCES } from '@/lib/constants';
import { orderHasDoc } from '@/lib/taxDocs';
import { NON_SALE_STATUSES_PG } from '@/lib/orderStatus';

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
                order_tax_documents(id, match_score, match_source, tax_documents(status))
              `)
              .gte('order_date', from)
              .lte('order_date', to)
              .not('status', 'in', NON_SALE_STATUSES_PG);
            if (canalId !== 'todos') q = q.eq('channel', canalId as any);
            // .range() pagination needs a deterministic sort, otherwise Postgres
            // doesn't guarantee stable ordering across pages and rows can be
            // skipped or duplicated at page boundaries.
            const { data: batch, error: e } = await q
              .order('order_date', { ascending: false })
              .order('id', { ascending: true })
              .range(offset, offset + PAGE - 1);
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
              .not('status', 'in', NON_SALE_STATUSES_PG)
              .order('order_date', { ascending: false })
              .order('id', { ascending: true })
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

        type CanalAgg = {
          ordenes: number; monto: number; comisiones: number;
          devoluciones: number; pagado: number; ordenesExactas: number;
        };
        const porCanalMap = new Map<string, CanalAgg>();
        const orderIdToChannel = new Map<string, string>();
        for (const r of rows) {
          const ch = (r.channel as string) ?? 'desconocido';
          orderIdToChannel.set(r.id, ch);
          const cur = porCanalMap.get(ch) ?? {
            ordenes: 0, monto: 0, comisiones: 0,
            devoluciones: 0, pagado: 0, ordenesExactas: 0,
          };
          cur.ordenes += 1;
          cur.monto += r.gross_amount ?? 0;
          cur.comisiones += Math.abs(r.commission_amount ?? 0);
          if (r.has_exact_data) {
            cur.pagado += r.net_amount ?? 0;
            cur.ordenesExactas += 1;
          }
          porCanalMap.set(ch, cur);
        }

        const conDteCount = rows.filter(r => orderHasDoc(r.order_tax_documents as any[])).length;
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

        // ── 6b. Devoluciones ─────────────────────────────────────────────────
        // El monto devuelto es la plata que MercadoPago confirmó como reembolsada
        // o contracargada (misma fuente que la pantalla Devoluciones), NO el bruto
        // de las órdenes canceladas. Una orden cancelada normalmente nunca se pagó:
        // contarla inflaba la cifra y, como ventasBrutas ya excluye las canceladas,
        // el líquido terminaba restándolas dos veces.
        const periodOrderIds: string[] = [];
        {
          let offset = 0;
          while (true) {
            let q = supabase
              .from('orders').select('id')
              .gte('order_date', from).lte('order_date', to)
              .order('id', { ascending: true })
              .range(offset, offset + PAGE - 1);
            if (canalId !== 'todos') q = q.eq('channel', canalId as any);
            const { data: batch, error: e } = await q;
            if (e) throw e;
            periodOrderIds.push(...(batch ?? []).map((o: any) => o.id));
            if ((batch ?? []).length < PAGE) break;
            offset += PAGE;
          }
        }
        let devolucionMonto = 0;
        for (let i = 0; i < periodOrderIds.length; i += 300) {
          const { data: pd } = await supabase
            .from('meli_payment_details')
            .select('order_id, net_received_amount, status')
            .in('order_id', periodOrderIds.slice(i, i + 300))
            .in('status', ['refunded', 'charged_back']);
          for (const p of (pd ?? []) as any[]) {
            const amt = Math.abs(p.net_received_amount ?? 0);
            devolucionMonto += amt;
            const ch = orderIdToChannel.get(p.order_id);
            if (ch) {
              const cur = porCanalMap.get(ch);
              if (cur) cur.devoluciones += amt;
            }
          }
        }

        const porCanal = Array.from(porCanalMap.entries()).map(([ch, v]) => ({
          canalId: ch,
          nombre: channelLabel(ch),
          ordenes: v.ordenes,
          monto: v.monto,
          comisiones: v.comisiones,
          devoluciones: v.devoluciones,
          esperado: v.monto - v.comisiones - v.devoluciones,
          pagado: v.pagado,
          ordenesExactas: v.ordenesExactas,
        }));

        // Cobertura tributaria de las devoluciones reales (órdenes 'returned'): una
        // devolución debería tener una NOTA DE CRÉDITO que la reverse ante el SII.
        // Las canceladas no entran acá — una cancelación sin pago no exige NC.
        // La NC sólo cuenta como cobertura si está vigente y su total cubre al menos
        // el bruto de la orden (una NC parcial no debe leerse como resuelta).
        let devQuery = supabase
          .from('orders')
          .select('gross_amount, order_tax_documents(id, tax_documents(status, document_type, total_amount))')
          .gte('order_date', from)
          .lte('order_date', to)
          .eq('status', 'returned');
        if (canalId !== 'todos') devQuery = devQuery.eq('channel', canalId as any);
        const { data: devRows } = await devQuery;
        const devConNC = (devRows ?? []).filter(r => {
          const links = (r.order_tax_documents as any[]) ?? [];
          const ncTotal = links.reduce((sum, l) => {
            const td = Array.isArray(l.tax_documents) ? l.tax_documents[0] : l.tax_documents;
            if (!td || td.status === 'voided' || td.document_type !== 'nota_credito') return sum;
            return sum + (td.total_amount ?? 0);
          }, 0);
          return ncTotal >= (r.gross_amount ?? 0) - 100;
        }).length;
        const devTotal = (devRows ?? []).length;

        // TODO: facturas de comisión de MeLi no disponibles en tax_documents aún
        const comisionConFactura = { pct: 0, faltan: 0 };

        // ── 7. Líquido (estimado, P&L) ───────────────────────────────────────
        // liquidoRecibido es un cálculo de estado de resultados (ventas − egresos
        // estimados), NO plata confirmada. Se mantiene para el waterfall, pero el
        // KPI "Recibido" de arriba usa recibidoReal (ver abajo), que es la única
        // cifra basada 100% en pagos confirmados por MercadoPago.
        const liquidoRecibido = ventasBrutas - comisionMonto - envioCosto - comisionPagoMonto - devolucionMonto;

        // ── 7b. Recibido real vs. por cobrar ─────────────────────────────────
        // Partición exacta de las órdenes del período según el único campo en
        // el que confiamos: has_exact_data. true = sync-meli-payment-details ya
        // trajo el pago real aprobado de MercadoPago (net_amount es real).
        // false = todavía no hay confirmación de pago, sea por estar pendiente
        // o por no haberse sincronizado — su monto bruto cuenta como "por cobrar"
        // en vez de inventar un neto estimado.
        const recibidoReal = rows.reduce((s, r) => s + (r.has_exact_data ? (r.net_amount ?? 0) : 0), 0);
        const porCobrar     = rows.reduce((s, r) => s + (!r.has_exact_data ? (r.gross_amount ?? 0) : 0), 0);

        // ── 8. Abonos banco ───────────────────────────────────────────────────
        let bankQuery = supabase
          .from('bank_movements')
          .select('amount')
          .gte('movement_date', from.slice(0, 10))
          .lte('movement_date', to.slice(0, 10));
        if (canalId !== 'todos') bankQuery = (bankQuery as any).eq('source_channel', canalId);
        const { data: bankRows } = await bankQuery;
        const abonosBanco = (bankRows ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);
        // Comparamos dos cifras reales (MP confirmado vs. banco confirmado), no
        // el estimado de P&L — así la diferencia refleja un problema real y no
        // ruido de órdenes sin sincronizar.
        const diferencia  = recibidoReal - abonosBanco;

        // ── 9. Excepciones ────────────────────────────────────────────────────
        const hoy = new Date();
        const pagosAtascados = rows.filter(r =>
          r.money_release_date && new Date(r.money_release_date) < hoy && !r.has_exact_data
        ).length;
        // scoreBajo = órdenes vinculadas a un documento por un match "soft" (score
        // calculado, no determinístico) cuyo match_score cae bajo SCORE_OK.
        // HARD_MATCH_SOURCES no llevan score real, así que se excluyen explícitamente.
        const scoreBajo = rows.filter(r => {
          const links = (r.order_tax_documents as any[]) ?? [];
          return links.some(l =>
            l.match_score != null && l.match_score < SCORE_OK && !HARD_MATCH_SOURCES.has(l.match_source)
          );
        }).length;

        // ── 9b. Candidatos pendientes de revisión manual ──────────────────────
        // order_tax_match_candidates: matches ambiguos que auto-reconcile no
        // vinculó solo y dejó para que un humano decida. Acotado al período y
        // canal seleccionados (igual que el resto del dashboard).
        let candQuery = supabase
          .from('order_tax_match_candidates')
          .select('tax_document_id, orders!inner(order_date, channel)')
          .eq('status', 'pending')
          .gte('orders.order_date', from)
          .lte('orders.order_date', to);
        if (canalId !== 'todos') candQuery = candQuery.eq('orders.channel', canalId as any);
        const { data: candRows } = await candQuery;
        const candidatosPendientes = new Set((candRows ?? []).map((r: any) => r.tax_document_id)).size;

        const excepciones: PeriodReconciliation['excepciones'] = [
          { tipo: 'venta_sin_dte',       label: 'Ventas sin boleta/factura',          count: conDte.faltan,    severidad: conDte.faltan > 0 ? 'danger' : 'warning' },
          { tipo: 'pago_atascado',       label: 'Pagos sin confirmar (faltan datos)', count: pagosAtascados,   severidad: 'warning' },
          { tipo: 'devolucion_sin_nc',   label: 'Devoluciones sin nota de crédito',   count: devTotal - devConNC, severidad: (devTotal - devConNC) > 0 ? 'danger' : 'warning' },
          { tipo: 'score_bajo',          label: 'Coincidencias de baja confianza',    count: scoreBajo,         severidad: 'warning' },
          { tipo: 'candidato_pendiente', label: 'Documentos con candidatos por revisar', count: candidatosPendientes, severidad: 'warning' },
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
            liquidoRecibido, recibidoReal, porCobrar, abonosBanco, diferencia, datosExactos, excepciones,
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
