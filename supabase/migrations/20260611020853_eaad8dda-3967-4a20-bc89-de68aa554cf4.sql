
CREATE TABLE public.raw_extraction_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('meli','bsale')),
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error')),
  current_step TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  file_size_bytes BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_extraction_jobs TO authenticated;
GRANT ALL ON public.raw_extraction_jobs TO service_role;
ALTER TABLE public.raw_extraction_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own raw extraction jobs"
  ON public.raw_extraction_jobs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX raw_extraction_jobs_user_period_idx
  ON public.raw_extraction_jobs (user_id, source, period, created_at DESC);
CREATE TRIGGER raw_extraction_jobs_updated_at
  BEFORE UPDATE ON public.raw_extraction_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
