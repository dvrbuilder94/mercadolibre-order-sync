-- Fase 3 (automatizar el Pipeline): el cron orquestador no tiene browser, así
-- que el checkpoint de paginación de Bsale (hoy en localStorage, ver
-- Pipeline.tsx) necesita un lugar server-side para persistir entre corridas.
CREATE TABLE IF NOT EXISTS public.bsale_sync_checkpoints (
  user_id UUID NOT NULL,
  period TEXT NOT NULL, -- 'YYYY-MM'
  cursor JSONB NOT NULL,
  batch_id TEXT,
  total_available INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

ALTER TABLE public.bsale_sync_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own bsale checkpoints"
  ON public.bsale_sync_checkpoints FOR SELECT
  USING (auth.uid() = user_id);

-- Log de corridas del cron orquestador, para tener visibilidad sin terminal
-- abierta (cron-refresh-meli-tokens ya loguea a console.log, pero eso solo
-- se ve en los Edge Function logs del dashboard, no en la app).
CREATE TABLE IF NOT EXISTS public.pipeline_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  user_id UUID,
  meli_account_id UUID,
  period TEXT,
  step TEXT NOT NULL, -- 'sync_meli_orders' | 'sync_payments' | 'sync_bsale' | 'enrich_ruts' | 'reconcile'
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'ok' | 'error'
  detail JSONB
);

ALTER TABLE public.pipeline_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own pipeline sync runs"
  ON public.pipeline_sync_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_sync_runs_started_at ON public.pipeline_sync_runs (started_at DESC);
