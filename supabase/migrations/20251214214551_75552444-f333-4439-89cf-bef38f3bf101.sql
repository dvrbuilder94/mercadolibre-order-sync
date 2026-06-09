-- Drop the partial index and create a proper unique constraint
DROP INDEX IF EXISTS payments_external_payment_id_unique;

-- Create a proper unique constraint for ON CONFLICT to work
ALTER TABLE public.payments 
ADD CONSTRAINT payments_external_payment_id_key UNIQUE (external_payment_id);