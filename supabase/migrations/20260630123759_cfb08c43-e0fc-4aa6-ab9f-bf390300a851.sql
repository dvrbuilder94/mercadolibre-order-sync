update orders set has_exact_data=false
where channel='meli' and coalesce(raw_data->>'pack_id','') in (
  select raw_data->>'pack_id' from orders
  where coalesce(raw_data->>'pack_id','')<>'' group by 1 having count(*)>1
);