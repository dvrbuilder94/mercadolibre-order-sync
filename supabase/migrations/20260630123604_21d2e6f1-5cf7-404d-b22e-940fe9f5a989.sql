update orders set has_exact_data=false
where channel='meli' and raw_data->>'pack_id'='2000011935358717';