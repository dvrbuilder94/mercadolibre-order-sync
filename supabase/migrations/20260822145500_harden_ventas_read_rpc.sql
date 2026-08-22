-- get_ventas_page is an authenticated tenant-scoped read surface.
-- SECURITY DEFINER avoids evaluating legacy provider-specific RLS policies for
-- every row; tenant isolation remains explicit through current_org_id().

alter function public.get_ventas_page(text,text,text,text,integer,integer) security definer;

revoke all on function public.get_ventas_page(text,text,text,text,integer,integer) from public;
revoke all on function public.get_ventas_page(text,text,text,text,integer,integer) from anon;
grant execute on function public.get_ventas_page(text,text,text,text,integer,integer) to authenticated;
