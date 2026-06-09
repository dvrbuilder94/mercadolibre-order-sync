-- Tabla para guardar estado de cierres mensuales
CREATE TABLE public.monthly_closings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  period TEXT NOT NULL, -- 'YYYY-MM'
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'closed', 'closed_with_observations'
  observations TEXT,
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  
  -- Snapshot de métricas al momento del cierre
  total_sales_count INTEGER,
  total_sales_amount NUMERIC,
  total_payments_count INTEGER,
  total_payments_amount NUMERIC,
  pending_sales_count INTEGER,
  pending_document_count INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(user_id, period)
);

-- Enable RLS
ALTER TABLE public.monthly_closings ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own closings"
ON public.monthly_closings
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own closings"
ON public.monthly_closings
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own closings"
ON public.monthly_closings
FOR UPDATE
USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_monthly_closings_updated_at
BEFORE UPDATE ON public.monthly_closings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();