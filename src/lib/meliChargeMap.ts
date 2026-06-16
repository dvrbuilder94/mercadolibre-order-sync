export type ChargeCategory =
  | 'comision_marketplace'
  | 'costos_envio'
  | 'comision_pago'
  | 'reembolso'
  | 'sin_categorizar';

// Maps fee_details[].type values from the MeLi Payments API to accounting categories.
// Kept in one place so rule updates don't scatter across the codebase.
const MAP: Record<string, ChargeCategory> = {
  // Marketplace commission
  mercadolibre_commission:      'comision_marketplace',
  marketplace_fee:              'comision_marketplace',
  sale_fee:                     'comision_marketplace',
  listing_fee:                  'comision_marketplace',
  advertising_fee:              'comision_marketplace',

  // Shipping
  shipping:                     'costos_envio',
  shipping_discount:            'costos_envio',
  carrier_fee:                  'costos_envio',
  fulfillment:                  'costos_envio',

  // Payment processing
  financing:                    'comision_pago',
  financing_fee:                'comision_pago',
  payment_fee:                  'comision_pago',
  mercadopago_fee:              'comision_pago',
  installment_fee:              'comision_pago',
  coupon:                       'comision_pago',

  // Refunds / chargebacks
  refund:                       'reembolso',
  chargeback:                   'reembolso',
  mediation:                    'reembolso',
  return:                       'reembolso',
};

export function classifyCharge(feeType: string): ChargeCategory {
  const key = feeType?.toLowerCase().trim();
  return MAP[key] ?? 'sin_categorizar';
}
