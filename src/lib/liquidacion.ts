// ¿La liquidación de esta orden está "colgada"? Es decir: MercadoPago nunca
// confirmó el pago (has_exact_data sigue false) y ya pasó el margen razonable
// para esperarlo. Sin esto, una orden con pago que nunca confirma se queda
// para siempre como "estimado" sin que nadie lo note.
//
// Dos señales, en orden de confianza:
// 1. Si la orden ya tiene una fecha de liberación estimada (money_release_date,
//    calculada por sync-meli-orders a partir de payment_approved_at) y esa
//    fecha ya pasó sin confirmación exacta: colgada.
// 2. Si nunca tuvo ni siquiera esa estimación (el pago jamás llegó a
//    aprobarse), usamos un margen fijo desde la fecha de la orden.
const STUCK_GRACE_DAYS = 5;

export interface LiquidacionLike {
  has_exact_data?: boolean | null;
  money_release_date?: string | null;
  order_date?: string | null;
}

export function daysSince(date: string | null | undefined): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
}

export function isLiquidacionStuck(o: LiquidacionLike): boolean {
  if (o.has_exact_data) return false;
  if (o.money_release_date) return new Date(o.money_release_date).getTime() < Date.now();
  const days = daysSince(o.order_date);
  return days != null && days > STUCK_GRACE_DAYS;
}
