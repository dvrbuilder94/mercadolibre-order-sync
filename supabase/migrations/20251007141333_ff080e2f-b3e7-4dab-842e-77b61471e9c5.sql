-- Add site_id column to meli_accounts table
ALTER TABLE public.meli_accounts 
ADD COLUMN IF NOT EXISTS site_id TEXT NOT NULL DEFAULT 'MLA';