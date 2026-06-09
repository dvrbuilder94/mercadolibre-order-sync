-- ========================================
-- MVP REFACTOR: Crear nuevas tablas (sin conflicto)
-- ========================================

-- 1. Añadir columnas a orders para el nuevo modelo
ALTER TABLE public.orders 
  ADD COLUMN IF NOT EXISTS marketplace text DEFAULT 'MELI',
  ADD COLUMN IF NOT EXISTS external_sale_id text,
  ADD COLUMN IF NOT EXISTS sale_status text DEFAULT 'PENDING_PAYMENT';

-- Poblar external_sale_id desde order_id
UPDATE public.orders SET external_sale_id = order_id WHERE external_sale_id IS NULL;

-- Poblar sale_status desde reconciliation_status
UPDATE public.orders SET sale_status = 
  CASE 
    WHEN reconciliation_status = 'reconciled' THEN 'PAID'
    ELSE 'PENDING_PAYMENT'
  END
WHERE sale_status = 'PENDING_PAYMENT' OR sale_status IS NULL;

-- 2. Añadir columnas a tax_documents para el nuevo modelo
ALTER TABLE public.tax_documents
  ADD COLUMN IF NOT EXISTS erp text DEFAULT 'BSALE',
  ADD COLUMN IF NOT EXISTS external_document_id text;

-- Poblar external_document_id desde external_id
UPDATE public.tax_documents SET external_document_id = external_id WHERE external_document_id IS NULL;

-- 3. Modificar tabla payments existente para el nuevo modelo
-- Primero verificamos y añadimos columnas necesarias
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_provider text DEFAULT 'MERCADOPAGO',
  ADD COLUMN IF NOT EXISTS external_payment_id text,
  ADD COLUMN IF NOT EXISTS net_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'UNALLOCATED';

-- 4. Crear tabla puente payment_sales (CORE del sistema)
CREATE TABLE IF NOT EXISTS public.payment_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  allocated_amount numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT payment_sales_unique UNIQUE (payment_id, sale_id)
);

-- 5. RLS para payment_sales
ALTER TABLE public.payment_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their payment_sales" ON public.payment_sales;
CREATE POLICY "Users can view their payment_sales" ON public.payment_sales
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.payments WHERE payments.id = payment_sales.payment_id AND payments.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can insert payment_sales" ON public.payment_sales;
CREATE POLICY "Users can insert payment_sales" ON public.payment_sales
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.payments WHERE payments.id = payment_sales.payment_id AND payments.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can delete payment_sales" ON public.payment_sales;
CREATE POLICY "Users can delete payment_sales" ON public.payment_sales
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.payments WHERE payments.id = payment_sales.payment_id AND payments.user_id = auth.uid())
  );

-- 6. Índices para performance
CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON public.orders(marketplace);
CREATE INDEX IF NOT EXISTS idx_orders_sale_status ON public.orders(sale_status);
CREATE INDEX IF NOT EXISTS idx_orders_external_sale_id ON public.orders(external_sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider ON public.payments(payment_provider);
CREATE INDEX IF NOT EXISTS idx_tax_documents_erp ON public.tax_documents(erp);
CREATE INDEX IF NOT EXISTS idx_tax_documents_external_order_id ON public.tax_documents(external_order_id);