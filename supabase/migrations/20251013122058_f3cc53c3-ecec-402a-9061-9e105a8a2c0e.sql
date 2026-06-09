-- Add status column to reconciliations table
ALTER TABLE reconciliations 
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'reconciled';

-- Add constraint to validate status values
ALTER TABLE reconciliations 
ADD CONSTRAINT check_reconciliation_status 
CHECK (status IN ('reconciled', 'partial', 'manual'));

-- Create trigger function to update bank_movements and orders when reconciliation is created
CREATE OR REPLACE FUNCTION update_bank_movement_reconciled()
RETURNS TRIGGER AS $$
BEGIN
  -- Update bank_movements to mark as reconciled
  UPDATE bank_movements 
  SET reconciled = TRUE 
  WHERE id = NEW.payment_id;
  
  -- Update orders reconciliation_status
  UPDATE orders 
  SET reconciliation_status = CASE 
    WHEN NEW.status = 'reconciled' THEN 'reconciled'::reconciliation_status
    WHEN NEW.status = 'partial' THEN 'partially_reconciled'::reconciliation_status
    ELSE 'pending'::reconciliation_status
  END
  WHERE id = NEW.order_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger
DROP TRIGGER IF EXISTS reconciliation_status_trigger ON reconciliations;
CREATE TRIGGER reconciliation_status_trigger
AFTER INSERT ON reconciliations
FOR EACH ROW
EXECUTE FUNCTION update_bank_movement_reconciled();