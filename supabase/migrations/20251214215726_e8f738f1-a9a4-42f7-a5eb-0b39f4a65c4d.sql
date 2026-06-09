-- Add unique constraint on settlements for upsert to work
ALTER TABLE public.settlements
ADD CONSTRAINT settlements_channel_account_period_key 
UNIQUE (channel, channel_account_id, period_start, period_end);