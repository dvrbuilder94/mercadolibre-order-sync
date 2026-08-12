
CREATE OR REPLACE FUNCTION public.get_monthly_control_snapshot(p_period text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  v_start := ((p_period || '-01')::date::timestamp) AT TIME ZONE 'America/Santiago';
  v_end := (((p_period || '-01')::date + interval '1 month')::timestamp) AT TIME ZONE 'America/Santiago';

  WITH o AS (
    SELECT
      COALESCE(ord.gross_amount, ord.amount, 0) AS gross,
      COALESCE(ord.has_exact_data, false) AS exact_payment,
      EXISTS (
        SELECT 1 FROM order_tax_documents otd
        JOIN tax_documents td ON td.id = otd.tax_document_id
        WHERE otd.order_id = ord.id AND COALESCE(td.status::text, 'issued') <> 'voided'
      ) AS has_dte
    FROM orders ord
    WHERE ord.order_date >= v_start AND ord.order_date < v_end
      AND COALESCE(ord.status, '') NOT IN ('cancelled', 'rejected', 'invalid')
  ),
  d AS (
    SELECT
      td.total_amount,
      td.tax_amount,
      td.document_type::text AS document_type,
      EXISTS (SELECT 1 FROM order_tax_documents otd WHERE otd.tax_document_id = td.id) AS linked
    FROM tax_documents td
    WHERE td.document_date >= (p_period || '-01')::date
      AND td.document_date < ((p_period || '-01')::date + interval '1 month')
      AND COALESCE(td.status::text, 'issued') = 'issued'
  ),
  p AS (
    SELECT
      COALESCE(pay.gross_amount, 0) AS gross,
      ABS(COALESCE(pay.fees_amount, 0)) AS fees,
      COALESCE(pay.net_amount, 0) AS net,
      COALESCE(pay.status, '') AS status,
      EXISTS (SELECT 1 FROM payment_sales ps WHERE ps.payment_id = pay.id) AS matched
    FROM payments pay
    WHERE pay.payment_date >= v_start AND pay.payment_date < v_end
      AND COALESCE(pay.raw_data->>'ledger_type', '') <> 'LOGICAL_BATCH'
  ),
  agg AS (
    SELECT
      (SELECT COUNT(*) FROM o) AS order_count,
      (SELECT COALESCE(SUM(gross), 0) FROM o) AS gross_sales,
      (SELECT COUNT(*) FROM o WHERE exact_payment) AS exact_count,
      (SELECT COUNT(*) FROM o WHERE NOT exact_payment) AS awaiting_count,
      (SELECT COUNT(*) FROM o WHERE has_dte) AS with_dte,
      (SELECT COUNT(*) FROM o WHERE NOT has_dte) AS without_dte,
      (SELECT COUNT(*) FROM d) AS doc_count,
      (SELECT COALESCE(SUM(CASE WHEN document_type = 'nota_credito' THEN -ABS(total_amount) ELSE total_amount END), 0) FROM d) AS gross_docs,
      (SELECT COALESCE(SUM(CASE WHEN document_type = 'nota_credito' THEN -ABS(tax_amount) ELSE tax_amount END), 0) FROM d) AS tax_docs,
      (SELECT COALESCE(SUM(ABS(total_amount)), 0) FROM d WHERE document_type = 'nota_credito') AS credit_notes,
      (SELECT COUNT(*) FROM d WHERE linked) AS linked_docs,
      (SELECT COUNT(*) FROM d WHERE NOT linked) AS unlinked_docs,
      (SELECT COUNT(*) FROM p) AS movement_count,
      (SELECT COALESCE(SUM(gross), 0) FROM p) AS gross_movements,
      (SELECT COALESCE(SUM(fees), 0) FROM p) AS fees,
      (SELECT COALESCE(SUM(gross - fees - net), 0) FROM p) AS other_deductions,
      (SELECT COALESCE(SUM(net), 0) FROM p) AS net_movements,
      (SELECT COALESCE(SUM(ABS(net)), 0) FROM p WHERE status IN ('REFUND', 'CHARGEBACK')) AS reversals,
      (SELECT COUNT(*) FROM p WHERE status = 'UNMATCHED' OR NOT matched) AS unmatched_count
  )
  SELECT jsonb_build_object(
    'period', p_period,
    'timezone', 'America/Santiago',
    'commercial', jsonb_build_object(
      'order_count', order_count,
      'gross_sales', gross_sales,
      'exact_payment_order_count', exact_count,
      'awaiting_payment_order_count', awaiting_count,
      'with_valid_dte_order_count', with_dte,
      'without_valid_dte_order_count', without_dte
    ),
    'fiscal', jsonb_build_object(
      'document_count', doc_count,
      'gross_documents', gross_docs,
      'tax_documents', tax_docs,
      'credit_notes', credit_notes,
      'linked_document_count', linked_docs,
      'unlinked_document_count', unlinked_docs
    ),
    'cash', jsonb_build_object(
      'movement_count', movement_count,
      'gross_movements', gross_movements,
      'fees', fees,
      'other_deductions', other_deductions,
      'net_movements', net_movements,
      'reversals', reversals,
      'unmatched_movement_count', unmatched_count
    ),
    'bridges', jsonb_build_object(
      'commercial_after_reversals', gross_sales - credit_notes,
      'fiscal_vs_commercial_after_reversals', gross_docs - (gross_sales - credit_notes),
      'cash_gross_vs_fiscal', gross_movements - gross_docs
    )
  ) INTO v_result
  FROM agg;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_control_snapshot(text) TO authenticated, service_role;
