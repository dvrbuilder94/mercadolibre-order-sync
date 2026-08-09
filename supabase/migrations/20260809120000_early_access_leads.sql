-- Persist pilot requests from the public landing page without exposing the
-- resulting contact list through the anon API.
create table if not exists public.early_access_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null default 'landing',
  status text not null default 'new',
  created_at timestamptz not null default now(),
  constraint early_access_leads_email_normalized
    check (email = lower(btrim(email))),
  constraint early_access_leads_email_format
    check (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  constraint early_access_leads_source_check
    check (source = 'landing'),
  constraint early_access_leads_status_check
    check (status in ('new', 'contacted', 'qualified', 'rejected')),
  constraint early_access_leads_email_key unique (email)
);

alter table public.early_access_leads enable row level security;

drop policy if exists "Anyone can request pilot access" on public.early_access_leads;
create policy "Anyone can request pilot access"
  on public.early_access_leads
  for insert
  to anon, authenticated
  with check (source = 'landing' and status = 'new');

revoke all on public.early_access_leads from anon, authenticated;
grant insert (email, source) on public.early_access_leads to anon, authenticated;

comment on table public.early_access_leads is
  'Pilot access requests captured from the public Quadra landing page.';
