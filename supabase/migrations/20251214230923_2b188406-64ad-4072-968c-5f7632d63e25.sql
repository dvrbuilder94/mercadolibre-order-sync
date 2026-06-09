-- Add payment method details columns to orders
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS payment_method_type text,
ADD COLUMN IF NOT EXISTS payment_method_brand text;