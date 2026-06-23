// Fuente única de verdad para "¿esta orden tiene documento tributario?".
//
// La regla de negocio es una sola, pero antes vivía duplicada en 4 lugares
// (Resumen, Ventas, Sincronización y Liquidaciones) y solo Resumen filtraba los
// documentos anulados. Eso hacía que una orden vinculada a una boleta anulada
// se viera como "con documento" en una pantalla y "sin documento" en otra.
//
// Regla: una orden tiene documento si tiene al menos un vínculo a un documento
// tributario VIGENTE (status distinto de 'voided'). Un documento anulado no
// cubre la venta ante el SII, así que no cuenta.
//
// Para usar estos helpers, la query debe traer el status del documento embebido:
//   order_tax_documents ( id, tax_documents ( status ) )

type TaxDocStatus = { status?: string | null } | null;

interface TaxDocLink {
  // PostgREST devuelve un objeto para relaciones to-one, pero algunos embeds lo
  // entregan como arreglo; aceptamos ambas formas.
  tax_documents?: TaxDocStatus | TaxDocStatus[];
}

/** Un documento cubre la venta solo si existe y no está anulado. */
export function linkIsVigente(link: TaxDocLink | null | undefined): boolean {
  if (!link) return false;
  const td = Array.isArray(link.tax_documents) ? link.tax_documents[0] : link.tax_documents;
  return td != null && td.status !== "voided";
}

/** True si la orden tiene al menos un documento tributario vigente vinculado. */
export function orderHasDoc(links: (TaxDocLink | null)[] | null | undefined): boolean {
  return (links ?? []).some(linkIsVigente);
}
