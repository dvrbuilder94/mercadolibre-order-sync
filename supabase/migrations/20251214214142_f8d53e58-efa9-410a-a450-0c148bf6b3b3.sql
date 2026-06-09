-- Add unique constraint on external_payment_id for idempotent upserts
-- First drop if exists to avoid conflicts
DROP INDEX IF EXISTS payments_external_payment_id_unique;

-- Create unique index on external_payment_id (allows NULL values)
CREATE UNIQUE INDEX payments_external_payment_id_unique 
ON public.payments (external_payment_id) 
WHERE external_payment_id IS NOT NULL;