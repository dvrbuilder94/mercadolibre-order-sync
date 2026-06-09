-- Fix search_path for security
CREATE OR REPLACE FUNCTION update_bank_movement_reconciled()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE bank_movements 
  SET reconciled = TRUE 
  WHERE id = NEW.payment_id;
  
  UPDATE orders 
  SET reconciliation_status = CASE 
    WHEN NEW.status = 'reconciled' THEN 'reconciled'::reconciliation_status
    WHEN NEW.status = 'partial' THEN 'partially_reconciled'::reconciliation_status
    ELSE 'pending'::reconciliation_status
  END
  WHERE id = NEW.order_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;