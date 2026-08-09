CREATE UNIQUE INDEX IF NOT EXISTS bank_movements_external_reference_key
  ON public.bank_movements (external_reference)
  WHERE external_reference IS NOT NULL;