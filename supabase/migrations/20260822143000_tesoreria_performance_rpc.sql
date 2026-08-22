-- Tesoreria performance pass: aggregate and paginate in Postgres.
-- Both RPCs are explicit tenant-scoped read surfaces. No source systems are called.

create or replace function public.get_tesoreria_summary(p_period text)
returns jsonb
language plpgsql
stable
security definer
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
      'count',0,'gross',0,'fees',0,'net',0,'released_net',0,'pending_net',0,
      'matched_count',0,'partial_count',0,'orphan_count',0,'orphan_amount',0,
      'unpaid_sales',0,'unpaid_amount',0,'paid_without_dte',0,
      'daily','[]'::jsonb,'methods','[]'::jsonb,'channels','[]'::jsonb,'upcoming','[]'::jsonb
    );
  end if;

  v_from := (to_date(p_period || '-01','YYYY-MM-DD'))::timestamp at time zone 'America/Santiago';
  v_to := ((to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month')::timestamp) at time zone 'America/Santiago';

  with base as (
    select
      p.*,
      coalesce(nullif(p.raw_data->'mp_payment'->>'payment_type_id',''), nullif(p.raw_data->>'payment_type_id',''), nullif(p.raw_data->>'payment_method_type',''), 'Sin información') as method,
      coalesce(link.sales_count,0) as sales_count,
      coalesce(link.sales_gross,0) as sales_gross,
      coalesce(link.docs_ok,0) as docs_ok,
      link.release_date,
      case
        when coalesce(link.sales_count,0)=0 then 'orphan'
        when coalesce(p.gross_amount,0) <> 0
          and abs(coalesce(link.sales_gross,0)-coalesce(p.gross_amount,0)) <= greatest(abs(coalesce(p.gross_amount,0))*0.005,5)
          then 'matched'
        else 'partial'
      end as match_state,
      case
        when p.status in ('REFUND','CHARGEBACK') then true
        when link.release_date is not null and link.release_date <= now() then true
        else false
      end as released
    from public.payments p
    left join lateral (
      select
        count(*)::int as sales_count,
        coalesce(sum(coalesce(o.gross_amount,0)),0)::numeric as sales_gross,
        count(*) filter (where exists (
          select 1 from public.order_tax_documents otd
          join public.tax_documents td on td.id=otd.tax_document_id
          where otd.order_id=o.id and td.organization_id=v_org and td.status::text <> 'voided'
        ))::int as docs_ok,
        max(o.money_release_date) as release_date
      from public.payment_sales ps
      join public.orders o on o.id=ps.sale_id and o.organization_id=v_org
      where ps.payment_id=p.id
    ) link on true
    where p.organization_id=v_org
      and p.payment_date >= v_from and p.payment_date < v_to
      and coalesce(p.raw_data->>'ledger_type','') <> 'LOGICAL_BATCH'
  ), totals as (
    select
      count(*)::int count,
      coalesce(sum(coalesce(gross_amount,0)),0)::numeric gross,
      coalesce(sum(coalesce(fees_amount,0)),0)::numeric fees,
      coalesce(sum(coalesce(net_amount,0)),0)::numeric net,
      coalesce(sum(coalesce(net_amount,0)) filter (where released),0)::numeric released_net,
      count(*) filter (where match_state='matched')::int matched_count,
      count(*) filter (where match_state='partial')::int partial_count,
      count(*) filter (where match_state='orphan')::int orphan_count,
      coalesce(sum(coalesce(net_amount,0)) filter (where match_state='orphan'),0)::numeric orphan_amount
    from base
  ), daily as (
    select (payment_date at time zone 'America/Santiago')::date as date,
      coalesce(sum(coalesce(net_amount,0)),0)::numeric net
    from base group by 1 order by 1
  ), methods as (
    select method as name, coalesce(sum(coalesce(net_amount,0)),0)::numeric value
    from base group by method order by value desc limit 8
  ), channel_alloc as (
    select b.id, ch.channel, b.net_amount / nullif(ch.channel_count,0) as value
    from base b
    join lateral (
      select o.channel::text channel, count(*) over()::numeric channel_count
      from (
        select distinct o.channel
        from public.payment_sales ps
        join public.orders o on o.id=ps.sale_id and o.organization_id=v_org
        where ps.payment_id=b.id
      ) o
    ) ch on true
  ), channels as (
    select channel as name, coalesce(sum(value),0)::numeric value
    from channel_alloc group by channel order by value desc
  ), unpaid as (
    select count(*)::int count, coalesce(sum(coalesce(o.gross_amount,0)),0)::numeric amount
    from public.orders o
    where o.organization_id=v_org
      and o.order_date >= v_from and o.order_date < v_to
      and o.status is not null and o.status not in ('cancelled','rejected','invalid')
      and not exists (select 1 from public.payment_sales ps where ps.sale_id=o.id)
  ), paid_without_dte as (
    select count(distinct o.id)::int count
    from public.orders o
    where o.organization_id=v_org
      and o.order_date >= v_from and o.order_date < v_to
      and o.status is not null and o.status not in ('cancelled','rejected','invalid')
      and exists (select 1 from public.payment_sales ps where ps.sale_id=o.id)
      and not exists (
        select 1 from public.order_tax_documents otd
        join public.tax_documents td on td.id=otd.tax_document_id
        where otd.order_id=o.id and td.organization_id=v_org and td.status::text <> 'voided'
      )
  ), upcoming as (
    select o.money_release_date::date as date,
      count(distinct p.id)::int count,
      coalesce(sum(distinct coalesce(p.net_amount,0)),0)::numeric net
    from public.orders o
    join public.payment_sales ps on ps.sale_id=o.id
    join public.payments p on p.id=ps.payment_id and p.organization_id=v_org
    where o.organization_id=v_org
      and o.money_release_date >= now()
      and o.money_release_date < now() + interval '30 days'
      and coalesce(p.raw_data->>'ledger_type','') <> 'LOGICAL_BATCH'
    group by 1 order by 1
  )
  select jsonb_build_object(
    'count',t.count,'gross',t.gross,'fees',t.fees,'net',t.net,
    'released_net',t.released_net,'pending_net',t.net-t.released_net,
    'matched_count',t.matched_count,'partial_count',t.partial_count,
    'orphan_count',t.orphan_count,'orphan_amount',t.orphan_amount,
    'unpaid_sales',u.count,'unpaid_amount',u.amount,'paid_without_dte',pwd.count,
    'daily',coalesce((select jsonb_agg(to_jsonb(d)) from daily d),'[]'::jsonb),
    'methods',coalesce((select jsonb_agg(to_jsonb(m)) from methods m),'[]'::jsonb),
    'channels',coalesce((select jsonb_agg(to_jsonb(c)) from channels c),'[]'::jsonb),
    'upcoming',coalesce((select jsonb_agg(to_jsonb(x)) from upcoming x),'[]'::jsonb)
  ) into v_result
  from totals t cross join unpaid u cross join paid_without_dte pwd;

  return v_result;
end;
$$;

create or replace function public.get_tesoreria_page(
  p_period text,
  p_match text default 'all',
  p_provider text default 'all',
  p_channel text default 'all',
  p_method text default 'all',
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
begin
  if v_org is null then return jsonb_build_object('rows','[]'::jsonb,'total',0,'providers','[]'::jsonb,'channels','[]'::jsonb,'methods','[]'::jsonb); end if;

  v_from := (to_date(p_period || '-01','YYYY-MM-DD'))::timestamp at time zone 'America/Santiago';
  v_to := ((to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month')::timestamp) at time zone 'America/Santiago';

  with base as (
    select
      p.*,
      coalesce(nullif(p.raw_data->'mp_payment'->>'payment_type_id',''), nullif(p.raw_data->>'payment_type_id',''), nullif(p.raw_data->>'payment_method_type',''), 'Sin información') as method,
      coalesce(link.sales_count,0) as sales_count,
      coalesce(link.sales_gross,0) as sales_gross,
      coalesce(link.channels,'[]'::jsonb) as channels_json,
      coalesce(link.search_text,'') as link_search,
      case
        when coalesce(link.sales_count,0)=0 then 'orphan'
        when coalesce(p.gross_amount,0) <> 0
          and abs(coalesce(link.sales_gross,0)-coalesce(p.gross_amount,0)) <= greatest(abs(coalesce(p.gross_amount,0))*0.005,5)
          then 'matched'
        else 'partial'
      end as match_state
    from public.payments p
    left join lateral (
      select
        count(*)::int sales_count,
        coalesce(sum(coalesce(o.gross_amount,0)),0)::numeric sales_gross,
        coalesce(jsonb_agg(distinct o.channel::text) filter (where o.channel is not null),'[]'::jsonb) channels,
        string_agg(concat_ws(' ',o.order_id,o.customer_name,o.product_title), ' ') search_text
      from public.payment_sales ps
      join public.orders o on o.id=ps.sale_id and o.organization_id=v_org
      where ps.payment_id=p.id
    ) link on true
    where p.organization_id=v_org
      and p.payment_date >= v_from and p.payment_date < v_to
      and coalesce(p.raw_data->>'ledger_type','') <> 'LOGICAL_BATCH'
  ), filtered as (
    select * from base b
    where (p_match='all' or b.match_state=p_match)
      and (p_provider='all' or coalesce(b.payment_provider,'—')=p_provider)
      and (p_channel='all' or b.channels_json ? p_channel)
      and (p_method='all' or b.method=p_method)
      and (coalesce(trim(p_search),'')='' or lower(concat_ws(' ',b.external_payment_id,b.reference,b.method,b.link_search)) like '%'||lower(trim(p_search))||'%')
  ), page_ids as (
    select id from filtered order by payment_date desc,id limit greatest(1,least(coalesce(p_limit,50),200)) offset greatest(coalesce(p_offset,0),0)
  ), page_rows as (
    select jsonb_build_object(
      'id',p.id,'external_payment_id',p.external_payment_id,'payment_provider',p.payment_provider,
      'payment_date',p.payment_date,'net_amount',p.net_amount,'fees_amount',p.fees_amount,
      'gross_amount',p.gross_amount,'amount',p.amount,'status',p.status,'raw_data',p.raw_data,
      'payment_sales',coalesce((
        select jsonb_agg(jsonb_build_object(
          'allocated_amount',ps.allocated_amount,
          'orders',jsonb_build_object(
            'id',o.id,'order_id',o.order_id,'channel',o.channel::text,'customer_name',o.customer_name,
            'product_title',o.product_title,'gross_amount',o.gross_amount,'order_date',o.order_date,
            'money_release_date',o.money_release_date,'installments',o.installments,'payment_method',o.payment_method,
            'has_exact_data',o.has_exact_data,
            'order_tax_documents',coalesce((
              select jsonb_agg(jsonb_build_object('id',otd.id,'tax_documents',jsonb_build_object(
                'id',td.id,'status',td.status::text,'document_type',td.document_type::text,
                'document_number',td.document_number,'external_url',td.external_url
              )))
              from public.order_tax_documents otd
              join public.tax_documents td on td.id=otd.tax_document_id and td.organization_id=v_org
              where otd.order_id=o.id
            ),'[]'::jsonb)
          )
        ))
        from public.payment_sales ps
        join public.orders o on o.id=ps.sale_id and o.organization_id=v_org
        where ps.payment_id=p.id
      ),'[]'::jsonb)
    ) row
    from public.payments p join page_ids x on x.id=p.id
    order by p.payment_date desc,p.id
  ), opts as (
    select
      coalesce(jsonb_agg(distinct payment_provider) filter (where payment_provider is not null),'[]'::jsonb) providers,
      coalesce(jsonb_agg(distinct method) filter (where method is not null),'[]'::jsonb) methods
    from base
  ), channel_opts as (
    select coalesce(jsonb_agg(distinct c),'[]'::jsonb) channels
    from base b cross join lateral jsonb_array_elements_text(b.channels_json) c
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(row) from page_rows),'[]'::jsonb),
    'total',(select count(*)::int from filtered),
    'providers',o.providers,'methods',o.methods,'channels',c.channels
  ) into v_result from opts o cross join channel_opts c;

  return v_result;
end;
$$;

revoke all on function public.get_tesoreria_summary(text) from public;
revoke all on function public.get_tesoreria_page(text,text,text,text,text,text,integer,integer) from public;
grant execute on function public.get_tesoreria_summary(text) to authenticated;
grant execute on function public.get_tesoreria_page(text,text,text,text,text,text,integer,integer) to authenticated;

create index if not exists idx_payment_sales_sale_id on public.payment_sales (sale_id, payment_id);
