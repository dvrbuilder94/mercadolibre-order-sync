-- Create enum for document types
CREATE TYPE public.document_type AS ENUM ('boleta', 'factura', 'nota_credito', 'nota_debito', 'factura_exenta');

-- Create tax_documents table to store Bsale documents
CREATE TABLE public.tax_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  
  -- Document identification
  document_type document_type NOT NULL,
  document_number TEXT NOT NULL,
  document_date DATE NOT NULL,
  
  -- Amounts
  net_amount NUMERIC(15,2) NOT NULL,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL,
  
  -- Client info
  client_name TEXT,
  client_tax_id TEXT, -- RUT in Chile
  
  -- External system reference (Bsale)
  external_system TEXT DEFAULT 'bsale',
  external_id TEXT, -- Bsale document ID
  external_url TEXT, -- Link to document in Bsale
  
  -- Additional data
  notes TEXT,
  raw_data JSONB,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, document_type, document_number)
);

-- Create many-to-many relationship between orders and tax documents
CREATE TABLE public.order_tax_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  tax_document_id UUID NOT NULL REFERENCES public.tax_documents(id) ON DELETE CASCADE,
  
  -- Track allocation (for partial associations)
  allocated_amount NUMERIC(15,2),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL,
  
  UNIQUE(order_id, tax_document_id)
);

-- Enable RLS
ALTER TABLE public.tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_tax_documents ENABLE ROW LEVEL SECURITY;

-- RLS policies for tax_documents
CREATE POLICY "Users can view their own tax documents"
  ON public.tax_documents FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own tax documents"
  ON public.tax_documents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tax documents"
  ON public.tax_documents FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tax documents"
  ON public.tax_documents FOR DELETE
  USING (auth.uid() = user_id);

-- RLS policies for order_tax_documents
CREATE POLICY "Users can view tax documents for their orders"
  ON public.order_tax_documents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_tax_documents.order_id
      AND CASE orders.channel
        WHEN 'meli' THEN EXISTS (
          SELECT 1 FROM meli_accounts 
          WHERE meli_accounts.id = orders.channel_account_id 
          AND meli_accounts.user_id = auth.uid()
        )
        WHEN 'falabella' THEN EXISTS (
          SELECT 1 FROM falabella_accounts 
          WHERE falabella_accounts.id = orders.channel_account_id 
          AND falabella_accounts.user_id = auth.uid()
        )
        WHEN 'amazon' THEN EXISTS (
          SELECT 1 FROM amazon_accounts 
          WHERE amazon_accounts.id = orders.channel_account_id 
          AND amazon_accounts.user_id = auth.uid()
        )
        WHEN 'shopify' THEN EXISTS (
          SELECT 1 FROM shopify_accounts 
          WHERE shopify_accounts.id = orders.channel_account_id 
          AND shopify_accounts.user_id = auth.uid()
        )
      END
    )
  );

CREATE POLICY "Users can insert tax documents for their orders"
  ON public.order_tax_documents FOR INSERT
  WITH CHECK (
    auth.uid() = created_by
    AND EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_tax_documents.order_id
      AND CASE orders.channel
        WHEN 'meli' THEN EXISTS (
          SELECT 1 FROM meli_accounts 
          WHERE meli_accounts.id = orders.channel_account_id 
          AND meli_accounts.user_id = auth.uid()
        )
        WHEN 'falabella' THEN EXISTS (
          SELECT 1 FROM falabella_accounts 
          WHERE falabella_accounts.id = orders.channel_account_id 
          AND falabella_accounts.user_id = auth.uid()
        )
        WHEN 'amazon' THEN EXISTS (
          SELECT 1 FROM amazon_accounts 
          WHERE amazon_accounts.id = orders.channel_account_id 
          AND amazon_accounts.user_id = auth.uid()
        )
        WHEN 'shopify' THEN EXISTS (
          SELECT 1 FROM shopify_accounts 
          WHERE shopify_accounts.id = orders.channel_account_id 
          AND shopify_accounts.user_id = auth.uid()
        )
      END
    )
  );

CREATE POLICY "Users can delete tax document associations for their orders"
  ON public.order_tax_documents FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_tax_documents.order_id
      AND CASE orders.channel
        WHEN 'meli' THEN EXISTS (
          SELECT 1 FROM meli_accounts 
          WHERE meli_accounts.id = orders.channel_account_id 
          AND meli_accounts.user_id = auth.uid()
        )
        WHEN 'falabella' THEN EXISTS (
          SELECT 1 FROM falabella_accounts 
          WHERE falabella_accounts.id = orders.channel_account_id 
          AND falabella_accounts.user_id = auth.uid()
        )
        WHEN 'amazon' THEN EXISTS (
          SELECT 1 FROM amazon_accounts 
          WHERE amazon_accounts.id = orders.channel_account_id 
          AND amazon_accounts.user_id = auth.uid()
        )
        WHEN 'shopify' THEN EXISTS (
          SELECT 1 FROM shopify_accounts 
          WHERE shopify_accounts.id = orders.channel_account_id 
          AND shopify_accounts.user_id = auth.uid()
        )
      END
    )
  );

-- Create indexes
CREATE INDEX idx_tax_documents_user ON public.tax_documents(user_id);
CREATE INDEX idx_tax_documents_date ON public.tax_documents(document_date);
CREATE INDEX idx_tax_documents_external_id ON public.tax_documents(external_system, external_id);
CREATE INDEX idx_order_tax_documents_order ON public.order_tax_documents(order_id);
CREATE INDEX idx_order_tax_documents_tax_doc ON public.order_tax_documents(tax_document_id);

-- Create trigger for updated_at
CREATE TRIGGER update_tax_documents_updated_at
  BEFORE UPDATE ON public.tax_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();