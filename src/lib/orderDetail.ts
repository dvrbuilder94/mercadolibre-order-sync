import { supabase } from "@/integrations/supabase/client";

// Forma completa de una orden tal como la necesita DetailPanel para dibujar la
// cadena Venta → Documento → Liquidación → Banco. Las listas de Ventas,
// Conciliación y Liquidaciones traen versiones recortadas de la orden (cada
// una con los campos que necesita su propia tabla); este select trae todo lo
// necesario para abrir el detalle completo sin importar desde qué página se
// pidió.
export const ORDER_DETAIL_SELECT = `
  id, order_id, order_date, status, channel, customer_name, customer_tax_id,
  customer_tax_id_dv, product_title, gross_amount, net_amount, payment_method,
  installments, money_release_date, payment_approved_at, has_exact_data, raw_data,
  discount_amount, shipping_cost, commission_percentage, commission_amount,
  settlement_amount, currency_id,
  order_tax_documents(id, tax_documents(document_number, document_type, external_url, status))
`;

export async function fetchOrderDetail(id: string) {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_DETAIL_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}
