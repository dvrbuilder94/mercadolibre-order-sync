import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, FileText, ExternalLink, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface TaxDocument {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  total_amount: number;
  client_name?: string;
  external_url?: string;
}

interface LinkTaxDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderAmount: number;
  onSuccess?: () => void;
  onCreateNew?: () => void;
}

const LinkTaxDocumentDialog = ({ 
  open, 
  onOpenChange, 
  orderId, 
  orderAmount,
  onSuccess,
  onCreateNew 
}: LinkTaxDocumentDialogProps) => {
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [documents, setDocuments] = useState<TaxDocument[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [allocatedAmount, setAllocatedAmount] = useState(orderAmount.toString());

  useEffect(() => {
    if (open) {
      loadDocuments();
    }
  }, [open, searchTerm]);

  const loadDocuments = async () => {
    setSearching(true);
    try {
      let query = supabase
        .from("tax_documents")
        .select("*")
        .order("document_date", { ascending: false })
        .limit(50);

      if (searchTerm) {
        query = query.or(`document_number.ilike.%${searchTerm}%,client_name.ilike.%${searchTerm}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      setDocuments(data || []);
    } catch (error: any) {
      console.error("Error loading documents:", error);
      toast.error("Error al cargar documentos");
    } finally {
      setSearching(false);
    }
  };

  const handleLink = async () => {
    if (!selectedDocId) {
      toast.error("Selecciona un documento");
      return;
    }

    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("No autenticado");

      const { error } = await supabase
        .from("order_tax_documents")
        .insert({
          order_id: orderId,
          tax_document_id: selectedDocId,
          created_by: user.id,
          allocated_amount: parseFloat(allocatedAmount),
        });

      if (error) throw error;

      toast.success("Documento asociado exitosamente");
      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      console.error("Error linking document:", error);
      if (error.code === '23505') {
        toast.error("Este documento ya está asociado a esta orden");
      } else {
        toast.error(error.message || "Error al asociar documento");
      }
    } finally {
      setLoading(false);
    }
  };

  const getDocumentTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      boleta: "Boleta",
      factura: "Factura",
      factura_exenta: "Factura Exenta",
      nota_credito: "NC",
      nota_debito: "ND",
    };
    return labels[type] || type;
  };

  const getDocumentTypeBadgeVariant = (type: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      boleta: "secondary",
      factura: "default",
      factura_exenta: "secondary",
      nota_credito: "destructive",
      nota_debito: "destructive",
    };
    return variants[type] || "default";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Asociar Documento Tributario</span>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onCreateNew?.();
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Crear Nuevo
            </Button>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Buscar Documento</Label>
            <Input
              placeholder="Buscar por número o cliente..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <ScrollArea className="h-[300px] border rounded-lg p-4">
            {searching ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No se encontraron documentos</p>
                <Button 
                  variant="link" 
                  onClick={() => {
                    onOpenChange(false);
                    onCreateNew?.();
                  }}
                >
                  Crear nuevo documento
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedDocId === doc.id 
                        ? "border-primary bg-primary/5" 
                        : "hover:border-primary/50"
                    }`}
                    onClick={() => {
                      setSelectedDocId(doc.id);
                      setAllocatedAmount(doc.total_amount.toString());
                    }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={getDocumentTypeBadgeVariant(doc.document_type)}>
                            {getDocumentTypeLabel(doc.document_type)}
                          </Badge>
                          <span className="font-mono font-semibold">
                            N° {doc.document_number}
                          </span>
                          {doc.external_url && (
                            <a 
                              href={doc.external_url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-primary hover:text-primary/80"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {doc.client_name && <p>{doc.client_name}</p>}
                          <p>Fecha: {new Date(doc.document_date).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">
                          ${doc.total_amount.toLocaleString('es-CL')}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {selectedDocId && (
            <div className="space-y-2 p-4 border rounded-lg bg-muted/50">
              <Label htmlFor="allocated_amount">
                Monto a Asignar (Total orden: ${orderAmount.toLocaleString('es-CL')})
              </Label>
              <Input
                id="allocated_amount"
                type="number"
                step="0.01"
                value={allocatedAmount}
                onChange={(e) => setAllocatedAmount(e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">
                Útil si el documento cubre parcialmente la orden o si hay múltiples documentos.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={handleLink} disabled={!selectedDocId || loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Asociar Documento
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LinkTaxDocumentDialog;
