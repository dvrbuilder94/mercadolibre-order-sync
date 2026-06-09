-- Create table for Falabella accounts
CREATE TABLE public.falabella_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  seller_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  site_id TEXT NOT NULL DEFAULT 'CL',
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS for Falabella accounts
ALTER TABLE public.falabella_accounts ENABLE ROW LEVEL SECURITY;

-- RLS policies for Falabella accounts
CREATE POLICY "Users can view their own falabella account"
  ON public.falabella_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own falabella account"
  ON public.falabella_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own falabella account"
  ON public.falabella_accounts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own falabella account"
  ON public.falabella_accounts FOR DELETE
  USING (auth.uid() = user_id);

-- Create table for Amazon accounts
CREATE TABLE public.amazon_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  region TEXT NOT NULL DEFAULT 'NA',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS for Amazon accounts
ALTER TABLE public.amazon_accounts ENABLE ROW LEVEL SECURITY;

-- RLS policies for Amazon accounts
CREATE POLICY "Users can view their own amazon account"
  ON public.amazon_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own amazon account"
  ON public.amazon_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own amazon account"
  ON public.amazon_accounts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own amazon account"
  ON public.amazon_accounts FOR DELETE
  USING (auth.uid() = user_id);

-- Create table for Shopify accounts
CREATE TABLE public.shopify_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_domain TEXT NOT NULL,
  access_token TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS for Shopify accounts
ALTER TABLE public.shopify_accounts ENABLE ROW LEVEL SECURITY;

-- RLS policies for Shopify accounts
CREATE POLICY "Users can view their own shopify account"
  ON public.shopify_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own shopify account"
  ON public.shopify_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own shopify account"
  ON public.shopify_accounts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own shopify account"
  ON public.shopify_accounts FOR DELETE
  USING (auth.uid() = user_id);