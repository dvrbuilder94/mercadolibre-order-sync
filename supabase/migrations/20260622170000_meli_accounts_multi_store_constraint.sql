-- Fase 2 (multi-tienda MELI): hoy UNIQUE(user_id) impide que un mismo
-- usuario conecte más de una cuenta MercadoLibre. Lo cambiamos a
-- UNIQUE(user_id, seller_id) para permitirlo. Los 11 edge functions que
-- resuelven la cuenta ya toleran múltiples filas por usuario desde la Fase 1
-- (account_id explícito, con fallback a "la más reciente").
--
-- Se busca dinámicamente el nombre real de la constraint UNIQUE(user_id) en
-- vez de asumir el nombre default (meli_accounts_user_id_key), por si fue
-- creada o renombrada distinto en algún momento.
DO $$
DECLARE
  con_name text;
  user_id_attnum smallint;
BEGIN
  SELECT attnum INTO user_id_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.meli_accounts'::regclass
    AND attname = 'user_id';

  SELECT con.conname INTO con_name
  FROM pg_constraint con
  WHERE con.conrelid = 'public.meli_accounts'::regclass
    AND con.contype = 'u'
    AND con.conkey = ARRAY[user_id_attnum];

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.meli_accounts DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.meli_accounts
  ADD CONSTRAINT meli_accounts_user_id_seller_id_key UNIQUE (user_id, seller_id);
