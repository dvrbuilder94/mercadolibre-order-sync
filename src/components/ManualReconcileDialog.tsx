import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface Payment {
  id: string;
  payment_date: string;
  amount: number;
  reference: string | null;
  bank: string | null;
}

interface ManualReconcileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string | null;
  onReconciled: () => void;
}

export const ManualReconcileDialog = ({ 
  open, 
  onOpenChange, 
  orderId,
  onReconciled 
}: ManualReconcileDialogProps) => {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingPayments, setLoadingPayments] = useState(false);

  useEffect(() => {
    if (open) {
      loadAvailablePayments();
    }
  }, [open]);

  const loadAvailablePayments = async () => {
    setLoadingPayments(true);
    try {
      // Get already reconciled payment IDs
      const { data: reconciliations } = await supabase
        .from('reconciliations')
        .select('payment_id');

      const reconciledPaymentIds = reconciliations?.map(r => r.payment_id) || [];

      // Get available payments
      const query = supabase
        .from('payments')
        .select('*')
        .order('payment_date', { ascending: false });

      if (reconciledPaymentIds.length > 0) {
        query.not('id', 'in', `(${reconciledPaymentIds.join(',')})`);
      }

      const { data, error } = await query;

      if (error) throw error;
      setPayments(data || []);
    } catch (error: any) {
      console.error('Error loading payments:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudieron cargar los pagos disponibles",
      });
    } finally {
      setLoadingPayments(false);
    }
  };

  const handleReconcile = async () => {
    if (!selectedPaymentId || !orderId) return;

    setLoading(true);
    try {
      const { error } = await supabase.functions.invoke('manual-reconcile', {
        body: {
          orderId,
          paymentId: selectedPaymentId,
          notes: notes.trim() || undefined,
        },
      });

      if (error) throw error;

      toast({
        title: "Conciliación exitosa",
        description: "La orden fue conciliada manualmente",
      });

      onReconciled();
      onOpenChange(false);
      setSelectedPaymentId("");
      setNotes("");
    } catch (error: any) {
      console.error('Error reconciling:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudo conciliar la orden",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Conciliación Manual</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="payment">Seleccionar Pago</Label>
            {loadingPayments ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay pagos disponibles para conciliar
              </p>
            ) : (
              <Select value={selectedPaymentId} onValueChange={setSelectedPaymentId}>
                <SelectTrigger id="payment">
                  <SelectValue placeholder="Selecciona un pago" />
                </SelectTrigger>
                <SelectContent>
                  {payments.map((payment) => (
                    <SelectItem key={payment.id} value={payment.id}>
                      <div className="flex flex-col">
                        <span>
                          ${Number(payment.amount).toLocaleString('es-AR')} - {' '}
                          {new Date(payment.payment_date).toLocaleDateString('es-AR')}
                        </span>
                        {payment.reference && (
                          <span className="text-xs text-muted-foreground">
                            {payment.reference}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notas (opcional)</Label>
            <Textarea
              id="notes"
              placeholder="Agrega notas sobre esta conciliación..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleReconcile}
              disabled={!selectedPaymentId || loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Conciliando...
                </>
              ) : (
                "Conciliar"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};