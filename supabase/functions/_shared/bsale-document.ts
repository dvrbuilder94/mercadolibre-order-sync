// Normalización canónica de documentos Bsale.
//
// Este módulo es la ÚNICA fuente de verdad para transformar un documento crudo
// de la API de Bsale en una fila de `tax_documents`. Lo comparten el full sync
// (`sync-bsale-docs`) y el webhook (`bsale-webhook`) para evitar writer drift:
// dos writers de la misma fila deben producir exactamente la misma forma.
//
// Regla dura: `coin.name` es la MONEDA ("Peso Chileno"), jamás la forma de pago.

export const VALID_SII_CODES = [33, 34, 39, 41, 56, 61];

export type BsaleDocType =
  | 'boleta'
  | 'factura'
  | 'nota_credito'
  | 'nota_debito'
  | 'factura_exenta';

export interface NormalizedBsalePayment {
  id: number | string | null;
  amount: number | null;
  recordDate: number | null;
  payment_type_id: string | null;
  payment_type_name: string | null;
}

export interface BsalePaymentEnrichment {
  payments: NormalizedBsalePayment[];
  payment_method_names: string[];
  payment_method_name: string | null;
}

export function normalizeCodeSii(codeSii: string | number | null | undefined): number | null {
  if (codeSii === null || codeSii === undefined || codeSii === '') return null;
  const normalized = Number(codeSii);
  return Number.isFinite(normalized) ? normalized : null;
}

// STRICT: sólo códigos SII tributarios válidos. Sin fallback por nombre.
export function mapBsaleDocType(codeSii: string | number | null | undefined): BsaleDocType | null {
  const normalized = normalizeCodeSii(codeSii);
  if (normalized === 33) return 'factura';
  if (normalized === 34) return 'factura_exenta';
  if (normalized === 39 || normalized === 41) return 'boleta';
  if (normalized === 56) return 'nota_debito';
  if (normalized === 61) return 'nota_credito';
  return null;
}

// RUT → cuerpo (dígitos) + DV (0-9 o K).
export function splitRut(rut: string | null | undefined): { body: string | null; dv: string | null } {
  if (!rut) return { body: null, dv: null };
  const clean = String(rut).replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2) return { body: null, dv: null };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
}

export function detectChannelFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  if (upper.includes('MERCADO LIBRE') || upper.includes('MERCADOLIBRE') ||
      upper.includes('MERCADO PAGO') || upper.includes('MERCADOPAGO') ||
      upper.includes('ML ') || upper.includes(' ML') || upper === 'ML') return 'meli';
  if (upper.includes('FALABELLA') || upper.includes('CMR')) return 'falabella';
  if (upper.includes('PARIS') || upper.includes('CENCOSUD') || upper.includes('PARIS.CL')) return 'paris';
  if (upper.includes('RIPLEY')) return 'ripley';
  if (upper.includes('AMAZON')) return 'amazon';
  if (upper.includes('SHOPIFY')) return 'shopify';
  if (upper.includes('LINIO')) return 'linio';
  if (upper.includes('RAPPI')) return 'rappi';
  if (upper.includes('WALMART') || upper.includes('LIDER') || upper.includes('LÍDER')) return 'walmart';
  return null;
}

export function detectChannelFromDoc(doc: any): string | null {
  if (doc?.references?.items?.length > 0) {
    for (const ref of doc.references.items) {
      const hit = detectChannelFromText(ref?.reason) || detectChannelFromText(ref?.number?.toString());
      if (hit) return hit;
    }
  }
  if (doc?.coin?.name) {
    const hit = detectChannelFromText(doc.coin.name);
    if (hit) return hit;
  }
  if (doc?.client?.note) {
    const hit = detectChannelFromText(doc.client.note);
    if (hit) return hit;
  }
  if (doc?.details?.items?.length > 0) {
    for (const detail of doc.details.items) {
      const hit = detectChannelFromText(detail?.comment);
      if (hit) return hit;
    }
  }
  return null;
}

export function extractExternalOrderId(doc: any): string | null {
  const orderIdPattern = /(\d{10,})/;

  if (doc?.client?.note) {
    const match = String(doc.client.note).match(orderIdPattern);
    if (match) return match[1];
  }

  if (doc?.references?.items?.length > 0) {
    for (const ref of doc.references.items) {
      const searchText = `${ref?.reason || ''} ${ref?.number || ''}`;
      const match = searchText.match(orderIdPattern);
      if (match) return match[1];
    }
  }

  if (doc?.details?.items?.length > 0) {
    for (const detail of doc.details.items) {
      if (detail?.comment) {
        const match = String(detail.comment).match(orderIdPattern);
        if (match) return match[1];
      }
    }
  }

  return null;
}

export function idFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = String(href).match(/\/(\d+)\.json/);
  return m ? m[1] : null;
}

// Bsale entrega `payments` como array directo o como colección `{ items: [] }`.
export function getPaymentItems(doc: any): any[] {
  const raw = doc?.payments;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

// Un item de `payments` puede venir ya expandido como el propio payment type
// (`href` apunta a /payment_types/<id>.json). Sólo en ese caso su `id`/`name`
// describen la forma de pago; en otros shapes `id` es el id del pago.
export function paymentTypeIdFromDirectItem(payment: any): string | null {
  const href = payment?.href;
  if (!href) return null;
  const m = String(href).match(/\/payment_types\/(\d+)\.json/);
  if (m) return m[1];
  return null;
}

export function isDirectPaymentTypeItem(payment: any): boolean {
  return paymentTypeIdFromDirectItem(payment) !== null;
}

// Resolución segura del id de forma de pago (nunca desde `coin`).
export function resolvePaymentTypeId(payment: any): string | null {
  if (payment?.payment_type?.id != null) return String(payment.payment_type.id);
  if (payment?.paymentTypeId != null) return String(payment.paymentTypeId);
  if (payment?.payment_type_id != null) return String(payment.payment_type_id);
  const nested = idFromHref(payment?.payment_type?.href);
  if (nested) return nested;
  const direct = paymentTypeIdFromDirectItem(payment);
  if (direct) return direct;
  return null;
}

// Pagos normalizados + nombres únicos de forma de pago REALES.
export function extractDocPayments(
  doc: any,
  typeNames: Map<string, string> = new Map(),
): BsalePaymentEnrichment {
  const items: any[] = getPaymentItems(doc);
  const payments: NormalizedBsalePayment[] = items.map((p: any) => {
    const ptId = resolvePaymentTypeId(p);
    const name = p?.payment_type?.name
      || (isDirectPaymentTypeItem(p) ? (p?.name ?? null) : null)
      || (ptId ? typeNames.get(ptId) : null)
      || null;
    const amount = typeof p?.amount === 'number'
      ? p.amount
      : (p?.amount != null && p.amount !== '' && Number.isFinite(Number(p.amount)) ? Number(p.amount) : null);
    const recordDate = p?.recordDate ?? p?.record_date ?? null;
    return {
      id: isDirectPaymentTypeItem(p) ? null : (p?.id ?? null),
      amount,
      recordDate,
      payment_type_id: ptId,
      payment_type_name: name,
    };
  });
  const payment_method_names = Array.from(
    new Set(payments.map((p) => p.payment_type_name).filter(Boolean)),
  ) as string[];
  return {
    payments,
    payment_method_names,
    payment_method_name: payment_method_names.length === 1 ? payment_method_names[0] : null,
  };
}

// IDs de payment_type que necesitan resolverse contra el catálogo porque el
// documento no trae `payment_type.name`.
export function unresolvedPaymentTypeIds(doc: any): string[] {
  const ids = getPaymentItems(doc)
    .filter((p: any) => !p?.payment_type?.name && !(isDirectPaymentTypeItem(p) && p?.name))
    .map((p: any) => resolvePaymentTypeId(p))
    .filter(Boolean) as string[];
  return Array.from(new Set(ids));
}

// Sólo documentos tributarios válidos (excluye guías de despacho, notas de venta…).
export function isValidTributaryDoc(doc: any): boolean {
  const codeSii = normalizeCodeSii(doc?.document_type?.codeSii);
  const typeName = String(doc?.document_type?.name || '').toUpperCase();
  if (codeSii === 52) return false;
  if (!codeSii && typeName.includes('NOTA VENTA')) return false;
  if (!codeSii && typeName.includes('GUÍA')) return false;
  return !!codeSii && VALID_SII_CODES.includes(codeSii);
}

export function filterValidTributaryDocs(docs: any[]): { valid: any[]; ignored: number } {
  const valid = docs.filter(isValidTributaryDoc);
  return { valid, ignored: docs.length - valid.length };
}

function chileCalendarDate(unixSeconds: number | null | undefined): string {
  const date = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

export interface BuildTaxDocumentOptions {
  userId: string;
  paymentTypeNames?: Map<string, string>;
  batchId?: string | null;
}

// Construye el payload canónico de `tax_documents` (mismo shape en full sync y webhook).
export function buildTaxDocumentPayload(doc: any, options: BuildTaxDocumentOptions): any | null {
  const codeSii = normalizeCodeSii(doc?.document_type?.codeSii);
  const docType = mapBsaleDocType(codeSii);
  if (!docType) return null;

  const clientName = doc?.client?.firstName && doc?.client?.lastName
    ? `${doc.client.firstName} ${doc.client.lastName}`.trim()
    : doc?.client?.company || doc?.client?.activity || 'Cliente';

  const { body: clientTaxId, dv: clientTaxIdDv } = splitRut(doc?.client?.code);

  const netAmount = parseFloat(doc?.netAmount || 0);
  const taxAmount = parseFloat(doc?.taxAmount || 0);
  const totalAmount = parseFloat(doc?.totalAmount || 0) || (netAmount + taxAmount);

  const externalOrderId = extractExternalOrderId(doc);
  const referenceReason = doc?.references?.items?.[0]?.reason ?? null;
  const enrichment = extractDocPayments(doc, options.paymentTypeNames ?? new Map());

  return {
    user_id: options.userId,
    document_type: docType,
    document_number: doc?.number?.toString() || String(doc?.id),
    document_date: chileCalendarDate(doc?.emissionDate),
    net_amount: netAmount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    client_name: clientName,
    client_tax_id: clientTaxId,
    client_tax_id_dv: clientTaxIdDv,
    external_system: 'bsale',
    external_id: String(doc?.id),
    external_order_id: externalOrderId,
    external_url: doc?.urlPublicView || doc?.urlPublicViewOriginal || doc?.urlPdf || null,
    erp: 'BSALE',
    status: doc?.state === 0 ? 'issued' : 'voided',
    sales_channel: 'MARKETPLACE',
    detected_channel: detectChannelFromDoc(doc),
    ...(options.batchId ? { resync_batch: options.batchId } : {}),
    raw_data: {
      id: doc?.id,
      number: doc?.number,
      emissionDate: doc?.emissionDate,
      codeSii: codeSii,
      typeName: doc?.document_type?.name,
      clientNote: doc?.client?.note,
      references: doc?.references,
      coin: doc?.coin || null,
      office: doc?.office,
      external_order_id: externalOrderId,
      reference_reason: referenceReason,
      payments: enrichment.payments,
      payment_method_names: enrichment.payment_method_names,
      payment_method_name: enrichment.payment_method_name,
      details: doc?.details?.items?.map((d: any) => ({
        description: d?.comment,
        quantity: d?.quantity,
        netAmount: d?.netAmount,
      })) || [],
    },
  };
}

// Un writer parcial (webhook con respuesta incompleta o catálogo caído) jamás
// debe borrar la forma de pago ya conocida: si el payload entrante no trae
// nombres utilizables, preserva el enriquecimiento existente.
export function mergePaymentEnrichment(
  incomingRawData: any,
  existingRawData: any | null | undefined,
): any {
  const incomingNames: string[] = incomingRawData?.payment_method_names || [];
  if (incomingNames.length > 0) return incomingRawData;

  const existingNames: string[] = existingRawData?.payment_method_names || [];
  const existingPayments = existingRawData?.payments;
  if (existingNames.length === 0 && !(Array.isArray(existingPayments) && existingPayments.length > 0)) {
    return incomingRawData;
  }

  return {
    ...incomingRawData,
    payments: Array.isArray(existingPayments) && existingPayments.length > 0
      ? existingPayments
      : incomingRawData?.payments ?? [],
    payment_method_names: existingNames,
    payment_method_name: existingRawData?.payment_method_name
      ?? (existingNames.length === 1 ? existingNames[0] : null),
  };
}