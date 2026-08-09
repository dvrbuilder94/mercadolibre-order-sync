-- Resolve manual reconciliation candidates in one transaction. The previous
-- browser flow inserted links and updated candidate statuses in separate
-- requests, which could leave a candidate pending after its link was created.
create or replace function public.resolve_match_candidates(
  p_tax_document_id uuid,
  p_candidate_ids uuid[],
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_expected integer;
  v_candidates integer;
  v_links integer;
  v_reviewed integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_action not in ('accept', 'reject') then
    raise exception 'Unsupported review action: %', p_action;
  end if;

  v_expected := coalesce(cardinality(p_candidate_ids), 0);
  if v_expected = 0 or (
    select count(distinct candidate_id)
    from unnest(p_candidate_ids) as candidate_id
  ) <> v_expected then
    raise exception 'Candidate IDs must be a non-empty unique list';
  end if;

  -- Lock and validate every selected candidate before changing anything.
  with locked_candidates as materialized (
    select c.id
    from public.order_tax_match_candidates c
    join public.tax_documents d on d.id = c.tax_document_id
    where c.id = any(p_candidate_ids)
      and c.tax_document_id = p_tax_document_id
      and c.status = 'pending'
      and d.user_id = v_user_id
    for update of c
  )
  select count(*) into v_candidates from locked_candidates;

  if v_candidates <> v_expected then
    raise exception 'One or more candidates are unavailable, already reviewed, or do not belong to this user';
  end if;

  if p_action = 'reject' then
    update public.order_tax_match_candidates
    set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now()
    where id = any(p_candidate_ids)
      and tax_document_id = p_tax_document_id
      and status = 'pending';

    get diagnostics v_reviewed = row_count;
    return jsonb_build_object('accepted', 0, 'rejected', v_reviewed);
  end if;

  insert into public.order_tax_documents (
    order_id,
    tax_document_id,
    allocated_amount,
    match_source,
    match_score,
    created_by
  )
  select
    c.order_id,
    c.tax_document_id,
    coalesce(o.gross_amount, o.amount, 0),
    'MANUAL_REVIEWED',
    c.match_score,
    v_user_id
  from public.order_tax_match_candidates c
  join public.orders o on o.id = c.order_id
  where c.id = any(p_candidate_ids)
    and c.tax_document_id = p_tax_document_id
  on conflict (order_id, tax_document_id) do nothing;

  -- The over-link protection trigger can skip an insert. Never mark a
  -- candidate accepted unless every selected order is now actually linked.
  select count(distinct c.order_id) into v_links
  from public.order_tax_match_candidates c
  join public.order_tax_documents l
    on l.order_id = c.order_id
   and l.tax_document_id = c.tax_document_id
  where c.id = any(p_candidate_ids)
    and c.tax_document_id = p_tax_document_id;

  if v_links <> v_expected then
    raise exception 'The selected option would over-allocate the document; no review changes were saved';
  end if;

  update public.order_tax_match_candidates
  set
    status = case when id = any(p_candidate_ids) then 'accepted' else 'rejected' end,
    reviewed_by = v_user_id,
    reviewed_at = now()
  where tax_document_id = p_tax_document_id
    and status = 'pending';

  get diagnostics v_reviewed = row_count;
  return jsonb_build_object(
    'accepted', v_expected,
    'rejected', greatest(v_reviewed - v_expected, 0)
  );
end;
$$;

revoke all on function public.resolve_match_candidates(uuid, uuid[], text) from public, anon;
grant execute on function public.resolve_match_candidates(uuid, uuid[], text) to authenticated;

comment on function public.resolve_match_candidates(uuid, uuid[], text) is
  'Atomically accepts or rejects manual reconciliation candidates owned by the authenticated user.';
