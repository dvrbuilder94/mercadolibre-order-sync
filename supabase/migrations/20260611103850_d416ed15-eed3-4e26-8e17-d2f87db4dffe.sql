
ALTER TABLE public.raw_extraction_jobs
  ADD COLUMN IF NOT EXISTS checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS chunks_count integer NOT NULL DEFAULT 0;

UPDATE public.raw_extraction_jobs
SET status = 'error',
    error_message = COALESCE(error_message, 'Estancado: la función se interrumpió por límite de tiempo. Vuelve a iniciar (ahora con resume automático).')
WHERE status IN ('running','pending')
  AND updated_at < NOW() - INTERVAL '90 seconds';
