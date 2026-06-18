-- sync-meli-payment-details procesa TODOS los pagos de una orden (cuotas,
-- pago parcial + reembolso, etc. — ver supabase/functions/sync-meli-payment-details/
-- index.ts:188 `for (const payment of payments)`), insertando una fila por pago
-- en meli_payment_details. La columna order_id quedó UNIQUE desde la creación
-- de la tabla (20251013103112), así que el segundo pago de cualquier orden con
-- más de un pago choca con esa restricción y se pierde en silencio: el insert
-- falla, el error solo incrementa el contador `errors`, y la orden queda
-- marcada has_exact_data=true con net_amount calculado solo del primer pago.
-- payment_id ya es UNIQUE NOT NULL y es la clave real de deduplicación
-- (es el target del upsert onConflict); order_id no necesita serlo.
do $$
declare
  con_name text;
begin
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
  where tc.table_schema = 'public'
    and tc.table_name = 'meli_payment_details'
    and tc.constraint_type = 'UNIQUE'
    and ccu.column_name = 'order_id';

  if con_name is not null then
    execute format('alter table public.meli_payment_details drop constraint %I', con_name);
  end if;
end $$;
