ALTER TABLE public.mercadopago_accounts
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS public_key text,
  ADD COLUMN IF NOT EXISTS last_settlement_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS connection_method text NOT NULL DEFAULT 'access_token';

CREATE TABLE IF NOT EXISTS public.mercadopago_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);

GRANT SELECT, INSERT, DELETE ON public.mercadopago_oauth_states TO authenticated;
GRANT ALL ON public.mercadopago_oauth_states TO service_role;

ALTER TABLE public.mercadopago_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mp_oauth_states_select_own" ON public.mercadopago_oauth_states
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "mp_oauth_states_insert_own" ON public.mercadopago_oauth_states
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "mp_oauth_states_delete_own" ON public.mercadopago_oauth_states
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_mp_oauth_states_expires_at
  ON public.mercadopago_oauth_states (expires_at);