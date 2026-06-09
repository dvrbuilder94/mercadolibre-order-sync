import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface InvoiceDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string | null;
  onSaved: () => void;
}

export const InvoiceDataDialog = ({ open, onOpenChange, orderId, onSaved }: InvoiceDataDialogProps) => {
  const [loading, setLoading] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState<Date>();
  const [customerTaxId, setCustomerTaxId] = useState("");
  const [vatRate, setVatRate] = useState("19.0");
  const [accountingCategory, setAccountingCategory] = useState("");
  const [costOfGoodsSold, setCostOfGoodsSold] = useState("");
  const [notesForAccountant, setNotesForAccountant] = useState("");

  useEffect(() => {
    if (open && orderId) {
      loadOrderData();
    } else {
      resetForm();
    }
  }, [open, orderId]);

  const loadOrderData = async () => {
    if (!orderId) return;

    try {
      const { data, error } = await supabase
        .from('orders')
        .select('invoice_number, invoice_date, customer_tax_id, vat_rate, accounting_category, cost_of_goods_sold, notes_for_accountant')
        .eq('id', orderId)
        .single();

      if (error) throw error;

      if (data) {
        setInvoiceNumber(data.invoice_number || "");
        setInvoiceDate(data.invoice_date ? new Date(data.invoice_date) : undefined);
        setCustomerTaxId(data.customer_tax_id || "");
        setVatRate(data.vat_rate?.toString() || "19.0");
        setAccountingCategory(data.accounting_category || "");
        setCostOfGoodsSold(data.cost_of_goods_sold?.toString() || "");
        setNotesForAccountant(data.notes_for_accountant || "");
      }
    } catch (error: any) {
      console.error('Error loading order data:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudieron cargar los datos de la orden",
      });
    }
  };

  const resetForm = () => {
    setInvoiceNumber("");
    setInvoiceDate(undefined);
    setCustomerTaxId("");
    setVatRate("19.0");
    setAccountingCategory("");
    setCostOfGoodsSold("");
    setNotesForAccountant("");
  };

  const handleSave = async () => {
    if (!orderId) return;

    setLoading(true);
    try {
      const updateData: any = {
        invoice_number: invoiceNumber || null,
        invoice_date: invoiceDate ? invoiceDate.toISOString() : null,
        customer_tax_id: customerTaxId || null,
        vat_rate: parseFloat(vatRate) || 19.0,
        accounting_category: accountingCategory || null,
        cost_of_goods_sold: costOfGoodsSold ? parseFloat(costOfGoodsSold) : null,
        notes_for_accountant: notesForAccountant || null,
      };

      const { error } = await supabase
        .from('orders')
        .update(updateData)
        .eq('id', orderId);

      if (error) throw error;

      toast({
        title: "Datos guardados",
        description: "Los datos fiscales se guardaron correctamente",
      });

      onSaved();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error saving invoice data:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudieron guardar los datos fiscales",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Datos Fiscales y Contables</DialogTitle>
          <DialogDescription>
            Ingresa la información fiscal y contable de esta orden
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="invoice-number">Número de Factura</Label>
            <Input
              id="invoice-number"
              placeholder="Ej: F-001-00123456"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label>Fecha de Factura</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start text-left font-normal",
                    !invoiceDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {invoiceDate ? format(invoiceDate, "PPP") : <span>Seleccionar fecha</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={invoiceDate}
                  onSelect={setInvoiceDate}
                  initialFocus
                  className="pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="customer-tax-id">RUT del Cliente</Label>
            <Input
              id="customer-tax-id"
              placeholder="Ej: 12.345.678-9"
              value={customerTaxId}
              onChange={(e) => setCustomerTaxId(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="vat-rate">Tasa de IVA (%)</Label>
            <Input
              id="vat-rate"
              type="number"
              step="0.01"
              placeholder="19.0"
              value={vatRate}
              onChange={(e) => setVatRate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              El monto neto y el IVA se calculan automáticamente
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="accounting-category">Categoría Contable</Label>
            <Input
              id="accounting-category"
              placeholder="Ej: Ventas Nacionales, Exportaciones, etc."
              value={accountingCategory}
              onChange={(e) => setAccountingCategory(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="cogs">Costo de Ventas (COGS)</Label>
            <Input
              id="cogs"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={costOfGoodsSold}
              onChange={(e) => setCostOfGoodsSold(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              El margen bruto se calcula automáticamente
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="notes">Notas para el Contador</Label>
            <Textarea
              id="notes"
              placeholder="Observaciones especiales, ajustes, etc."
              value={notesForAccountant}
              onChange={(e) => setNotesForAccountant(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Guardando...
              </>
            ) : (
              "Guardar"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
