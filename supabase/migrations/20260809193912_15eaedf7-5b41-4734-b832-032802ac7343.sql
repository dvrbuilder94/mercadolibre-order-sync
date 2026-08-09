CREATE TABLE IF NOT EXISTS public.mercadopago_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  mp_user_id text,
  nickname text,
  email text,
  site_id text,
  status text NOT NULL DEFAULT 'connected',
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mp_user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mercadopago_accounts TO authenticated;
GRANT ALL ON public.mercadopago_accounts TO service_role;

ALTER TABLE public.mercadopago_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mp_accounts_select_own" ON public.mercadopago_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "mp_accounts_insert_own" ON public.mercadopago_accounts
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "mp_accounts_update_own" ON public.mercadopago_accounts
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "mp_accounts_delete_own" ON public.mercadopago_accounts
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TRIGGER update_mercadopago_accounts_updated_at
  BEFORE UPDATE ON public.mercadopago_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();