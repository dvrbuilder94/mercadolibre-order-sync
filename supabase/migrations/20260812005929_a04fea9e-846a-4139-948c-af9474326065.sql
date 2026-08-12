
WITH links AS (
  SELECT ps.id AS link_id, p.id AS pid, p.gross_amount AS pg, p.net_amount AS pn,
         o.id AS oid, o.gross_amount AS og
  FROM payment_sales ps
  JOIN payments p ON p.id = ps.payment_id
  JOIN orders o ON o.id = ps.sale_id
  WHERE o.raw_data->>'pack_id' IS NOT NULL
),
exactm AS (
  SELECT pid, (array_agg(oid))[1] AS target_oid, count(*) AS n
  FROM links WHERE abs(pg - og) < 1 GROUP BY pid
),
snap AS (SELECT pid, target_oid FROM exactm WHERE n = 1),
to_delete AS (
  SELECT l.link_id FROM links l JOIN snap s ON s.pid = l.pid WHERE l.oid <> s.target_oid
),
deleted AS (
  DELETE FROM payment_sales WHERE id IN (SELECT link_id FROM to_delete)
)
UPDATE payment_sales ps
SET allocated_amount = l.pn
FROM links l JOIN snap s ON s.pid = l.pid AND s.target_oid = l.oid
WHERE ps.id = l.link_id AND ps.allocated_amount IS DISTINCT FROM l.pn;
