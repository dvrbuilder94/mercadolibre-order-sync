-- Multichannel Ventas read model: server-side pagination and aggregates.
-- Keeps large monthly scans in Postgres and scopes every result to current_org_id().

create or replace function public.get_ventas_page(
  p_period text,
  p_channel text default 'todos',
  p_doc_filter text default 'todos',
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
begin
  if v_org is null then
    return jsonb_build_object(
      'rows','[]'::jsonb,'total',0,'gross_amount',0,'with_document',0,'without_document',0,
      'stuck_count',0,'stuck_amount',0,'discarded_count',0,'discarded_amount',0,'channels','[]'::jsonb
    );
  end if;

  v_from := (to_date(p_period || '-01', 'YYYY-MM-DD'))::timestamp at time zone 'America/Santiago';
  v_to := ((to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month')::timestamp) at time zone 'America/Santiago';

  with scoped as (
    select
      o.*,
      exists (
        select 1
        from public.order_tax_documents otd
        join public.tax_documents td on td.id = otd.tax_document_id
        where otd.order_id = o.id
          and td.organization_id = v_org
          and td.status::text <> 'voided'
      ) as has_document,
      (
        select jsonb_build_object(
          'document_number', td.document_number,
          'document_type', td.document_type::text,
          'external_url', td.external_url,
          'status', td.status::text
        )
        from public.order_tax_documents otd
        join public.tax_documents td on td.id = otd.tax_document_id
        where otd.order_id = o.id
          and td.organization_id = v_org
          and td.status::text <> 'voided'
        order by td.document_date desc nulls last, td.id
        limit 1
      ) as linked_document,
      (
        coalesce(o.has_exact_data,false) = false
        and (
          (o.money_release_date is not null and o.money_release_date < now())
          or (o.money_release_date is null and o.order_date < now() - interval '5 days')
        )
      ) as is_stuck
    from public.orders o
    where o.organization_id = v_org
      and o.order_date >= v_from
      and o.order_date < v_to
  ), real_sales as (
    select *
    from scoped s
    where s.status is not null
      and s.status not in ('cancelled','rejected','invalid')
      and (p_channel = 'todos' or s.channel::text = p_channel)
  ), filtered as (
    select *
    from real_sales s
    where (
        p_doc_filter = 'todos'
        or (p_doc_filter = 'con' and s.has_document)
        or (p_doc_filter = 'sin' and not s.has_document)
      )
      and (
        coalesce(trim(p_search),'') = ''
        or lower(concat_ws(' ', s.order_id, s.customer_name, s.product_title, s.customer_tax_id, s.external_sale_id))
          like '%' || lower(trim(p_search)) || '%'
      )
  ), stats as (
    select
      count(*)::int total,
      coalesce(sum(coalesce(gross_amount,0)),0)::numeric gross_amount,
      count(*) filter (where has_document)::int with_document,
      count(*) filter (where not has_document)::int without_document,
      count(*) filter (where is_stuck)::int stuck_count,
      coalesce(sum(coalesce(gross_amount,0)) filter (where is_stuck),0)::numeric stuck_amount
    from real_sales
  ), discarded as (
    select
      count(*)::int discarded_count,
      coalesce(sum(coalesce(gross_amount,0)),0)::numeric discarded_amount
    from scoped s
    where s.status in ('cancelled','rejected','invalid')
      and (p_channel = 'todos' or s.channel::text = p_channel)
  ), channels as (
    select
      coalesce(channel::text,'sin_canal') as channel,
      count(*)::int count,
      coalesce(sum(coalesce(gross_amount,0)),0)::numeric amount,
      count(*) filter (where has_document)::int with_document,
      count(*) filter (where not has_document)::int without_document
    from real_sales
    group by 1
    order by amount desc
  ), page_rows as (
    select jsonb_build_object(
      'id', s.id,
      'order_id', s.order_id,
      'order_date', s.order_date,
      'status', s.status,
      'channel', s.channel::text,
      'customer_name', s.customer_name,
      'customer_tax_id', s.customer_tax_id,
      'customer_tax_id_dv', s.customer_tax_id_dv,
      'product_title', s.product_title,
      'gross_amount', s.gross_amount,
      'net_amount', s.net_amount,
      'payment_method', s.payment_method,
      'installments', s.installments,
      'money_release_date', s.money_release_date,
      'payment_approved_at', s.payment_approved_at,
      'has_exact_data', s.has_exact_data,
      'linked_document', s.linked_document,
      'has_document', s.has_document,
      'is_stuck', s.is_stuck
    ) row
    from filtered s
    order by s.order_date desc, s.id
    limit greatest(1, least(coalesce(p_limit,50),200))
    offset greatest(coalesce(p_offset,0),0)
  ), filtered_count as (
    select count(*)::int total from filtered
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(row) from page_rows),'[]'::jsonb),
    'filtered_total', fc.total,
    'total', st.total,
    'gross_amount', st.gross_amount,
    'with_document', st.with_document,
    'without_document', st.without_document,
    'stuck_count', st.stuck_count,
    'stuck_amount', st.stuck_amount,
    'discarded_count', d.discarded_count,
    'discarded_amount', d.discarded_amount,
    'channels', coalesce((select jsonb_agg(to_jsonb(c)) from channels c),'[]'::jsonb)
  ) into v_result
  from stats st cross join discarded d cross join filtered_count fc;

  return v_result;
end;
$$;

grant execute on function public.get_ventas_page(text,text,text,text,integer,integer) to authenticated;

-- Existing org/date index handles the monthly tenant scan. These support the two
-- most common secondary filters without adding wide or provider-specific indexes.
create index if not exists idx_orders_org_channel_date
  on public.orders (organization_id, channel, order_date desc);

create index if not exists idx_orders_org_status_date
  on public.orders (organization_id, status, order_date desc);
