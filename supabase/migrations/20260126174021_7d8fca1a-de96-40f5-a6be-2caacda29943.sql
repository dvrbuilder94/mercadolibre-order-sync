-- Create table for storing ambiguous match candidates
CREATE TABLE public.order_tax_match_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_document_id UUID NOT NULL REFERENCES public.tax_documents(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  match_score INTEGER NOT NULL,
  breakdown JSONB NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(tax_document_id, order_id)
);

-- Enable RLS
ALTER TABLE public.order_tax_match_candidates ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can manage candidates for their own tax documents
CREATE POLICY "Users can view their match candidates"
ON public.order_tax_match_candidates
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.tax_documents td
    WHERE td.id = order_tax_match_candidates.tax_document_id
    AND td.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert match candidates"
ON public.order_tax_match_candidates
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.tax_documents td
    WHERE td.id = order_tax_match_candidates.tax_document_id
    AND td.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update their match candidates"
ON public.order_tax_match_candidates
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.tax_documents td
    WHERE td.id = order_tax_match_candidates.tax_document_id
    AND td.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete their match candidates"
ON public.order_tax_match_candidates
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.tax_documents td
    WHERE td.id = order_tax_match_candidates.tax_document_id
    AND td.user_id = auth.uid()
  )
);

-- Add index for performance
CREATE INDEX idx_match_candidates_tax_doc ON public.order_tax_match_candidates(tax_document_id);
CREATE INDEX idx_match_candidates_order ON public.order_tax_match_candidates(order_id);
CREATE INDEX idx_match_candidates_status ON public.order_tax_match_candidates(status);