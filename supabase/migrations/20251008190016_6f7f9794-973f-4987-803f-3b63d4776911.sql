-- Add unique constraint for orders to enable proper upsert
ALTER TABLE public.orders 
ADD CONSTRAINT orders_channel_account_order_unique 
UNIQUE (channel_account_id, order_id);