// Mapea el status crudo de una orden de MercadoLibre a nuestro vocabulario
// normalizado. Compartido por sync-meli-orders y meli-webhook para que una
// orden tenga SIEMPRE el mismo estado, sin importar qué proceso la escribió
// (antes el webhook guardaba el status crudo de ML y el sync lo mapeaba, así
// que la misma orden podía verse distinta según cuál corrió último).
//
// Vocabulario normalizado:
//   delivered / shipped → envío entregado / despachado (venta viva)
//   confirmed           → pagada (venta viva)
//   pending             → esperando pago (venta viva, aún por cobrar)
//   cancelled / invalid / rejected → la venta no se concretó

export type NormalizedOrderStatus =
  | "delivered" | "shipped" | "confirmed" | "pending"
  | "cancelled" | "invalid" | "rejected";

interface MeliOrderLike {
  status?: string | null;
  shipping?: { status?: string | null } | null;
}

export function mapMeliOrderStatus(order: MeliOrderLike): NormalizedOrderStatus {
  // Estados sin venta concretada primero: una orden cancelada/inválida/rechazada
  // no debe quedar tapada por el estado de envío.
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "invalid")   return "invalid";
  if (order.status === "rejected")  return "rejected";
  // Venta viva: el envío manda si ya avanzó.
  if (order.shipping?.status === "delivered") return "delivered";
  if (order.shipping?.status === "shipped")   return "shipped";
  if (order.status === "paid") return "confirmed";
  return "pending";
}
