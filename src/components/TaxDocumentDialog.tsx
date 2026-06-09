import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

interface TaxDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId?: string;
  onSuccess?: () => void;
}

const TaxDocumentDialog = ({ open, onOpenChange, orderId, onSuccess }: TaxDocumentDialogProps) => {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    document_type: "factura" as const,
    document_number: "",
    document_date: new Date().toISOString().split('T')[0],
    net_amount: "",
    tax_amount: "",
    total_amount: "",
    client_name: "",
    client_tax_id: "",
    external_id: "",
    external_url: "",
    notes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("No autenticado");

      // Create tax document
      const { data: taxDoc, error: docError } = await supabase
        .from("tax_documents")
        .insert({
          user_id: user.id,
          document_type: formData.document_type,
          document_number: formData.document_number,
          document_date: formData.document_date,
          net_amount: parseFloat(formData.net_amount),
          tax_amount: parseFloat(formData.tax_amount || "0"),
          total_amount: parseFloat(formData.total_amount),
          client_name: formData.client_name || null,
          client_tax_id: formData.client_tax_id || null,
          external_id: formData.external_id || null,
          external_url: formData.external_url || null,
          notes: formData.notes || null,
        })
        .select()
        .single();

      if (docError) throw docError;

      // If orderId provided, link document to order
      if (orderId && taxDoc) {
        const { error: linkError } = await supabase
          .from("order_tax_documents")
          .insert({
            order_id: orderId,
            tax_document_id: taxDoc.id,
            created_by: user.id,
            allocated_amount: parseFloat(formData.total_amount),
          });

        if (linkError) throw linkError;
      }

      toast.success("Documento tributario creado exitosamente");
      onOpenChange(false);
      onSuccess?.();
      
      // Reset form
      setFormData({
        document_type: "factura",
        document_number: "",
        document_date: new Date().toISOString().split('T')[0],
        net_amount: "",
        tax_amount: "",
        total_amount: "",
        client_name: "",
        client_tax_id: "",
        external_id: "",
        external_url: "",
        notes: "",
      });
    } catch (error: any) {
      console.error("Error creating tax document:", error);
      toast.error(error.message || "Error al crear documento tributario");
    } finally {
      setLoading(false);
    }
  };

  const handleTotalCalculation = () => {
    const net = parseFloat(formData.net_amount || "0");
    const tax = parseFloat(formData.tax_amount || "0");
    setFormData(prev => ({ ...prev, total_amount: (net + tax).toString() }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo Documento Tributario</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="document_type">Tipo de Documento</Label>
              <Select
                value={formData.document_type}
                onValueChange={(value: any) => setFormData(prev => ({ ...prev, document_type: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boleta">Boleta</SelectItem>
                  <SelectItem value="factura">Factura</SelectItem>
                  <SelectItem value="factura_exenta">Factura Exenta</SelectItem>
                  <SelectItem value="nota_credito">Nota de Crédito</SelectItem>
                  <SelectItem value="nota_debito">Nota de Débito</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="document_number">Número de Documento</Label>
              <Input
                id="document_number"
                value={formData.document_number}
                onChange={(e) => setFormData(prev => ({ ...prev, document_number: e.target.value }))}
                placeholder="Ej: 12345"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="document_date">Fecha del Documento</Label>
            <Input
              id="document_date"
              type="date"
              value={formData.document_date}
              onChange={(e) => setFormData(prev => ({ ...prev, document_date: e.target.value }))}
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="net_amount">Monto Neto</Label>
              <Input
                id="net_amount"
                type="number"
                step="0.01"
                value={formData.net_amount}
                onChange={(e) => setFormData(prev => ({ ...prev, net_amount: e.target.value }))}
                onBlur={handleTotalCalculation}
                placeholder="0.00"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tax_amount">IVA (19%)</Label>
              <Input
                id="tax_amount"
                type="number"
                step="0.01"
                value={formData.tax_amount}
                onChange={(e) => setFormData(prev => ({ ...prev, tax_amount: e.target.value }))}
                onBlur={handleTotalCalculation}
                placeholder="0.00"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="total_amount">Total</Label>
              <Input
                id="total_amount"
                type="number"
                step="0.01"
                value={formData.total_amount}
                onChange={(e) => setFormData(prev => ({ ...prev, total_amount: e.target.value }))}
                placeholder="0.00"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="client_name">Nombre Cliente</Label>
              <Input
                id="client_name"
                value={formData.client_name}
                onChange={(e) => setFormData(prev => ({ ...prev, client_name: e.target.value }))}
                placeholder="Razón social o nombre"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="client_tax_id">RUT Cliente</Label>
              <Input
                id="client_tax_id"
                value={formData.client_tax_id}
                onChange={(e) => setFormData(prev => ({ ...prev, client_tax_id: e.target.value }))}
                placeholder="12.345.678-9"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="external_id">ID Bsale (opcional)</Label>
              <Input
                id="external_id"
                value={formData.external_id}
                onChange={(e) => setFormData(prev => ({ ...prev, external_id: e.target.value }))}
                placeholder="ID del documento en Bsale"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="external_url">URL Bsale (opcional)</Label>
              <Input
                id="external_url"
                value={formData.external_url}
                onChange={(e) => setFormData(prev => ({ ...prev, external_url: e.target.value }))}
                placeholder="https://..."
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notas (opcional)</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Información adicional..."
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Crear Documento
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default TaxDocumentDialog;
