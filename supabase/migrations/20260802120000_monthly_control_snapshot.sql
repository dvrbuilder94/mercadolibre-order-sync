-- One authenticated, RLS-scoped source for the three monthly axes shown by
-- Quadra. Commercial, fiscal and cash totals deliberately keep their own date
-- column; their differences are bridges, not interchangeable KPIs.
create or replace function public.get_monthly_control_snapshot(p_period text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_from_date date;
  v_to_date date;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid period. Expected YYYY-MM' using errcode = '22007';
  end if;

  v_from_date := (p_period || '-01')::date;
  v_to_date := (v_from_date + interval '1 month')::date;
  v_from := v_from_date::timestamp at time zone 'America/Santiago';
  v_to := v_to_date::timestamp at time zone 'America/Santiago';

  with commercial as (
    select
      count(*)::integer as order_count,
      coalesce(sum(o.gross_amount), 0)::numeric as gross_sales,
      count(*) filter (where o.has_exact_data is true)::integer as exact_payment_order_count,
      count(*) filter (where o.has_exact_data is not true)::integer as awaiting_payment_order_count,
      count(*) filter (where exists (
        select 1
        from order_tax_documents otd
        join tax_documents td on td.id = otd.tax_document_id
        where otd.order_id = o.id and td.status is distinct from 'voided'
      ))::integer as with_valid_dte_order_count
    from orders o
    where o.order_date >= v_from and o.order_date < v_to
      and o.status not in ('cancelled', 'rejected', 'invalid')
  ), fiscal as (
    select
      count(*)::integer as document_count,
      coalesce(sum(case when td.document_type = 'nota_credito'
        then -abs(td.total_amount) else td.total_amount end), 0)::numeric as gross_documents,
      coalesce(sum(case when td.document_type = 'nota_credito'
        then -abs(td.tax_amount) else td.tax_amount end), 0)::numeric as tax_documents,
      coalesce(sum(case when td.document_type = 'nota_credito'
        then abs(td.total_amount) else 0 end), 0)::numeric as credit_notes,
      count(*) filter (where exists (
        select 1 from order_tax_documents otd where otd.tax_document_id = td.id
      ))::integer as linked_document_count
    from tax_documents td
    where td.document_date >= v_from_date and td.document_date < v_to_date
      and td.status = 'issued'
  ), cash as (
    select
      count(*)::integer as movement_count,
      coalesce(sum(p.gross_amount), 0)::numeric as gross_movements,
      coalesce(sum(abs(p.fees_amount)), 0)::numeric as fees,
      coalesce(sum(p.gross_amount - abs(coalesce(p.fees_amount, 0)) - p.net_amount), 0)::numeric as other_deductions,
      coalesce(sum(p.net_amount), 0)::numeric as net_movements,
      coalesce(sum(case when p.status in ('REFUND', 'CHARGEBACK')
        then abs(p.net_amount) else 0 end), 0)::numeric as reversals,
      count(*) filter (where p.status = 'UNMATCHED' or not exists (
        select 1 from payment_sales ps where ps.payment_id = p.id
      ))::integer as unmatched_movement_count
    from payments p
    where p.payment_date >= v_from and p.payment_date < v_to
      and coalesce(p.raw_data->>'ledger_type', '') <> 'LOGICAL_BATCH'
  )
  select jsonb_build_object(
    'period', p_period,
    'timezone', 'America/Santiago',
    'commercial', jsonb_build_object(
      'order_count', c.order_count,
      'gross_sales', c.gross_sales,
      'exact_payment_order_count', c.exact_payment_order_count,
      'awaiting_payment_order_count', c.awaiting_payment_order_count,
      'with_valid_dte_order_count', c.with_valid_dte_order_count,
      'without_valid_dte_order_count', c.order_count - c.with_valid_dte_order_count
    ),
    'fiscal', jsonb_build_object(
      'document_count', f.document_count,
      'gross_documents', f.gross_documents,
      'tax_documents', f.tax_documents,
      'credit_notes', f.credit_notes,
      'linked_document_count', f.linked_document_count,
      'unlinked_document_count', f.document_count - f.linked_document_count
    ),
    'cash', jsonb_build_object(
      'movement_count', k.movement_count,
      'gross_movements', k.gross_movements,
      'fees', k.fees,
      'other_deductions', k.other_deductions,
      'net_movements', k.net_movements,
      'reversals', k.reversals,
      'unmatched_movement_count', k.unmatched_movement_count
    ),
    'bridges', jsonb_build_object(
      'commercial_after_reversals', c.gross_sales - f.credit_notes,
      'fiscal_vs_commercial_after_reversals', f.gross_documents - (c.gross_sales - f.credit_notes),
      'cash_gross_vs_fiscal', k.gross_movements - f.gross_documents
    )
  ) into v_result
  from commercial c cross join fiscal f cross join cash k;

  return v_result;
end;
$$;

revoke all on function public.get_monthly_control_snapshot(text) from public;
revoke all on function public.get_monthly_control_snapshot(text) from anon;
grant execute on function public.get_monthly_control_snapshot(text) to authenticated;

comment on function public.get_monthly_control_snapshot(text) is
  'Canonical RLS-scoped monthly commercial/fiscal/cash snapshot in America/Santiago.';
