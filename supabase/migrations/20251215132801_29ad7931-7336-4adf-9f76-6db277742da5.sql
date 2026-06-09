-- Create bsale_accounts table to store Bsale credentials per user
CREATE TABLE public.bsale_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  cpn_id TEXT, -- Company identifier in Bsale (from webhook)
  webhook_url TEXT, -- Generated webhook URL for this account
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.bsale_accounts ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own bsale account" 
ON public.bsale_accounts 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own bsale account" 
ON public.bsale_accounts 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own bsale account" 
ON public.bsale_accounts 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bsale account" 
ON public.bsale_accounts 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_bsale_accounts_updated_at
BEFORE UPDATE ON public.bsale_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();