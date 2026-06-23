// Fuente única de verdad para "¿esta orden es una venta concretada?".
//
// Estos estados NO representan una venta real: la plata nunca entró (orden
// cancelada, rechazada por pago fallido, o invalidada por MercadoLibre). Por
// eso no suman a ventas brutas, por cobrar, cobertura de documentos ni bloquean
// el cierre de mes. Se siguen MOSTRANDO (p. ej. en una tarjeta aparte en
// Ventas), pero separadas del neto.
//
// Antes el sistema solo excluía 'cancelled', así que una orden con pago
// rechazado se contaba como venta viva, inflaba "por cobrar" y, como nunca iba
// a tener boleta, quedaba para siempre como un falso "sin documento".
//
// Usar la MISMA lista en todos los módulos evita que una orden se vea como
// venta en una pantalla y como descartada en otra.

export const NON_SALE_STATUSES = ["cancelled", "rejected", "invalid"] as const;

// Para filtros PostgREST: .not("status", "in", NON_SALE_STATUSES_PG)
export const NON_SALE_STATUSES_PG = `(${NON_SALE_STATUSES.join(",")})`;

export const isRealSale = (status: string | null | undefined): boolean =>
  status != null && !(NON_SALE_STATUSES as readonly string[]).includes(status);

export const NON_SALE_LABEL: Record<string, string> = {
  cancelled: "Cancelada", rejected: "Rechazada", invalid: "Inválida",
};
