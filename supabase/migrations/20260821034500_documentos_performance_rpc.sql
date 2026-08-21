-- Performance pass for Documentos: keep monthly aggregation/filtering in Postgres.
-- These functions are tenant-scoped through current_org_id() and expose no credentials.

create or replace function public.document_channel(p_detected text, p_raw jsonb)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(p_detected, ''),
    case
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like any (array['%MERCADO LIBRE%','%MERCADOLIBRE%','%MERCADO PAGO%','%MERCADOPAGO%']) then 'meli'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like any (array['%FALABELLA%','%CMR%']) then 'falabella'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like any (array['%PARIS%','%CENCOSUD%']) then 'paris'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like '%RIPLEY%' then 'ripley'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like '%AMAZON%' then 'amazon'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like '%SHOPIFY%' then 'shopify'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like '%LINIO%' then 'linio'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like '%RAPPI%' then 'rappi'
      when upper(coalesce(p_raw->>'reference_reason','') || ' ' || coalesce(p_raw->'references','[]'::jsonb)::text) like any (array['%WALMART%','%LIDER%','%LÍDER%']) then 'walmart'
      else null
    end
  );
$$;

create or replace function public.get_documentos_page(
  p_period text,
  p_channel text default 'todos',
  p_doc_type text default 'todos',
  p_status text default 'todos',
  p_link_filter text default 'todos',
  p_pay_filter text default 'todas',
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
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if v_org is null then
    return jsonb_build_object('rows','[]'::jsonb,'total',0,'total_amount',0,'tax_amount',0,'payment_methods','[]'::jsonb);
  end if;

  v_from := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_to := (v_from + interval '1 month')::date;

  with base as (
    select
      d.*,
      public.document_channel(d.detected_channel, d.raw_data) as resolved_channel,
      exists(select 1 from public.order_tax_documents otd where otd.tax_document_id = d.id) as has_sale
    from public.tax_documents d
    where d.organization_id = v_org
      and d.document_date >= v_from
      and d.document_date < v_to
  ), filtered as (
    select *
    from base b
    where (p_channel = 'todos' or b.resolved_channel = p_channel)
      and (p_doc_type = 'todos' or b.document_type = p_doc_type)
      and (
        p_status = 'todos'
        or (p_status = 'voided' and b.status = 'voided')
        or (p_status = 'issued' and b.status <> 'voided')
      )
      and (
        p_link_filter = 'todos'
        or (p_link_filter = 'con' and b.has_sale)
        or (p_link_filter = 'sin' and not b.has_sale)
      )
      and (
        p_pay_filter = 'todas'
        or (p_pay_filter = '__sin__' and jsonb_array_length(case when jsonb_typeof(b.raw_data->'payment_method_names')='array' then b.raw_data->'payment_method_names' else '[]'::jsonb end) = 0)
        or (p_pay_filter not in ('todas','__sin__') and coalesce(b.raw_data->'payment_method_names','[]'::jsonb) ? p_pay_filter)
      )
      and (
        coalesce(trim(p_search),'') = ''
        or lower(concat_ws(' ', b.document_number, b.client_tax_id, b.client_tax_id_dv, b.external_order_id, b.raw_data->>'reference_reason', b.raw_data->'references')) like '%' || lower(trim(p_search)) || '%'
      )
  ), stats as (
    select
      count(*)::int as total,
      coalesce(sum(case when status <> 'voided' then (case when document_type='nota_credito' then -1 else 1 end) * coalesce(total_amount,0) else 0 end),0)::numeric as total_amount,
      coalesce(sum(case when status <> 'voided' then (case when document_type='nota_credito' then -1 else 1 end) * coalesce(tax_amount,0) else 0 end),0)::numeric as tax_amount
    from filtered
  ), rows_page as (
    select jsonb_build_object(
      'id', f.id,
      'document_number', f.document_number,
      'document_type', f.document_type,
      'document_date', f.document_date,
      'net_amount', f.net_amount,
      'tax_amount', f.tax_amount,
      'total_amount', f.total_amount,
      'status', f.status,
      'detected_channel', f.resolved_channel,
      'client_name', f.client_name,
      'client_tax_id', f.client_tax_id,
      'client_tax_id_dv', f.client_tax_id_dv,
      'external_order_id', f.external_order_id,
      'external_url', f.external_url,
      'raw_data', f.raw_data,
      'has_sale', f.has_sale,
      'sale_count', (select count(*) from public.order_tax_documents otd where otd.tax_document_id=f.id)
    ) as row
    from filtered f
    order by f.document_date desc, f.id asc
    limit greatest(1, least(coalesce(p_limit,50),200))
    offset greatest(coalesce(p_offset,0),0)
  ), pay_options as (
    select distinct value #>> '{}' as name
    from base b
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(b.raw_data->'payment_method_names')='array' then b.raw_data->'payment_method_names' else '[]'::jsonb end
    ) value
    where nullif(trim(value #>> '{}'),'') is not null
    order by 1
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(row) from rows_page),'[]'::jsonb),
    'total', s.total,
    'total_amount', s.total_amount,
    'tax_amount', s.tax_amount,
    'payment_methods', coalesce((select jsonb_agg(name) from pay_options),'[]'::jsonb)
  ) into v_result
  from stats s;

  return v_result;
end;
$$;

create or replace function public.get_documentos_summary(
  p_period text,
  p_channel text default 'todos'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if v_org is null then
    return jsonb_build_object(
      'documentsIssued',0,'sales',0,'documentedSales',0,'undocumentedSales',0,
      'net',0,'tax',0,'total',0,'creditNotes',0,'creditNotesAmount',0,
      'composition','[]'::jsonb,'channels','[]'::jsonb,'paymentMethods','[]'::jsonb
    );
  end if;

  v_from := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_to := (v_from + interval '1 month')::date;

  with docs as (
    select d.*, public.document_channel(d.detected_channel,d.raw_data) as resolved_channel
    from public.tax_documents d
    where d.organization_id=v_org
      and d.document_date >= v_from and d.document_date < v_to
      and d.status <> 'voided'
      and (p_channel='todos' or public.document_channel(d.detected_channel,d.raw_data)=p_channel)
  ), doc_totals as (
    select
      count(*)::int documents_issued,
      coalesce(sum((case when document_type='nota_credito' then -1 else 1 end)*coalesce(net_amount,0)),0)::numeric net,
      coalesce(sum((case when document_type='nota_credito' then -1 else 1 end)*coalesce(tax_amount,0)),0)::numeric tax,
      coalesce(sum((case when document_type='nota_credito' then -1 else 1 end)*coalesce(total_amount,0)),0)::numeric total,
      count(*) filter (where document_type='nota_credito')::int credit_notes,
      coalesce(sum(abs(coalesce(total_amount,0))) filter (where document_type='nota_credito'),0)::numeric credit_notes_amount
    from docs
  ), composition as (
    select document_type as type, count(*)::int count,
      sum((case when document_type='nota_credito' then -1 else 1 end)*coalesce(total_amount,0))::numeric amount
    from docs group by document_type order by count(*) desc
  ), channels as (
    select coalesce(resolved_channel,'sin_detectar') channel, count(*)::int count,
      sum((case when document_type='nota_credito' then -1 else 1 end)*coalesce(total_amount,0))::numeric amount
    from docs group by 1 order by count(*) desc
  ), sales as (
    select o.id
    from public.orders o
    where o.organization_id=v_org
      and o.order_date >= v_from::timestamp
      and o.order_date < v_to::timestamp
      and o.status is not null
      and o.status not in ('cancelled','rejected','invalid')
      and (p_channel='todos' or o.channel=p_channel)
  ), sales_stats as (
    select
      count(*)::int sales,
      count(*) filter (where exists(
        select 1
        from public.order_tax_documents otd
        join public.tax_documents td on td.id=otd.tax_document_id
        where otd.order_id=s.id and td.organization_id=v_org and td.status <> 'voided'
      ))::int documented_sales
    from sales s
  ), actual_payment_rows as (
    select
      d.id,
      coalesce(nullif(trim(p.elem->>'payment_type_name'),''),'Sin información') name,
      case when coalesce(p.elem->>'amount','') ~ '^[0-9]+([.][0-9]+)?$' then (p.elem->>'amount')::numeric else 0 end amount,
      coalesce(d.total_amount,0)::numeric doc_total
    from docs d
    cross join lateral jsonb_array_elements(case when jsonb_typeof(d.raw_data->'payments')='array' then d.raw_data->'payments' else '[]'::jsonb end) p(elem)
    where d.document_type <> 'nota_credito'
      and coalesce(d.total_amount,0) > 0
      and coalesce(p.elem->>'amount','') ~ '^[0-9]+([.][0-9]+)?$'
      and (p.elem->>'amount')::numeric > 0
  ), actual_alloc as (
    select id,name,doc_total * amount / nullif(sum(amount) over(partition by id),0) allocated
    from actual_payment_rows
  ), fallback_alloc as (
    select d.id,
      case
        when jsonb_typeof(d.raw_data->'payment_method_names')='array'
          and jsonb_array_length(d.raw_data->'payment_method_names')=1
        then nullif(trim(d.raw_data->'payment_method_names'->>0),'')
        else 'Sin información'
      end name,
      coalesce(d.total_amount,0)::numeric allocated
    from docs d
    where d.document_type <> 'nota_credito'
      and coalesce(d.total_amount,0) > 0
      and not exists(select 1 from actual_payment_rows a where a.id=d.id)
  ), payment_methods as (
    select coalesce(name,'Sin información') name, sum(allocated)::numeric amount
    from (
      select name,allocated from actual_alloc
      union all
      select name,allocated from fallback_alloc
    ) x
    group by 1
    having sum(allocated)>0
    order by sum(allocated) desc
  )
  select jsonb_build_object(
    'documentsIssued',dt.documents_issued,
    'sales',ss.sales,
    'documentedSales',ss.documented_sales,
    'undocumentedSales',greatest(0,ss.sales-ss.documented_sales),
    'net',dt.net,'tax',dt.tax,'total',dt.total,
    'creditNotes',dt.credit_notes,'creditNotesAmount',dt.credit_notes_amount,
    'composition',coalesce((select jsonb_agg(to_jsonb(c)) from composition c),'[]'::jsonb),
    'channels',coalesce((select jsonb_agg(to_jsonb(c)) from channels c),'[]'::jsonb),
    'paymentMethods',coalesce((select jsonb_agg(to_jsonb(p)) from payment_methods p),'[]'::jsonb)
  ) into v_result
  from doc_totals dt cross join sales_stats ss;

  return v_result;
end;
$$;

grant execute on function public.get_documentos_page(text,text,text,text,text,text,text,integer,integer) to authenticated;
grant execute on function public.get_documentos_summary(text,text) to authenticated;

-- Existing tenant/date indexes already cover the main monthly scans. Add a link index
-- that avoids repeated heap scans when filtering "con/sin venta".
create index if not exists idx_order_tax_documents_tax_doc_order on public.order_tax_documents (tax_document_id, order_id);
