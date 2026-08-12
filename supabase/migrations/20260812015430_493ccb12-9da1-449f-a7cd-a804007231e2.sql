CREATE TABLE public.payment_sales_repair_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  repair_batch_id uuid NOT NULL,
  repaired_at timestamp with time zone NOT NULL DEFAULT now(),
  payment_id uuid NOT NULL,
  external_payment_id text,
  sale_id uuid NOT NULL,
  allocated_amount numeric,
  payment_gross numeric,
  sum_order_gross numeric,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payment_sales_repair_log TO authenticated;
GRANT ALL ON public.payment_sales_repair_log TO service_role;

ALTER TABLE public.payment_sales_repair_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read repair log"
ON public.payment_sales_repair_log
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));