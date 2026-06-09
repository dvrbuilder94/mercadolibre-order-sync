-- Add company fields to profiles table
ALTER TABLE public.profiles
ADD COLUMN company_name TEXT,
ADD COLUMN company_tax_id TEXT,
ADD COLUMN company_address TEXT,
ADD COLUMN company_phone TEXT,
ADD COLUMN company_website TEXT;