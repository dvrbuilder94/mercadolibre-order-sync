import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, ExternalLink, Package, User, CreditCard, Calendar, Receipt, FileText } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";

interface Order {
  id: string;
  external_sale_id: string;
  marketplace: string;
  channel: string;
  order_date: string;
  customer_name: string;
  customer_email: string | null;
  customer_tax_id: string | null;
  product_title: string | null;
  seller_sku: string | null;
  items: number;
  gross_amount: number | null;
  commission_amount: number | null;
  financing_fee: number | null;
  shipping_cost: number | null;
  net_amount: number | null;
  payment_method: string | null;
  payment_method_brand: string | null;
  installments: number | null;
  status: string;
  sale_status: string | null;
  money_release_date: string | null;
}

interface TaxDocument {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  total_amount: number;
  client_name: string | null;
  client_tax_id: string | null;
  external_url: string | null;
}

// DB ya guarda solo el cuerpo (sin DV). Mostrar tal cual, solo dígitos.
const formatRut = (rut: string): string => rut.replace(/[^0-9]/g, '');

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'paid':
      return <Badge variant="default">Pagada</Badge>;
    case 'cancelled':
      return <Badge variant="destructive">Cancelada</Badge>;
    case 'pending':
      return <Badge variant="secondary">Pendiente</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const getDocTypeBadge = (type: string) => {
  switch (type) {
    case 'boleta':
      return <Badge variant="default">Boleta</Badge>;
    case 'factura':
      return <Badge variant="secondary">Factura</Badge>;
    case 'nota_credito':
      return <Badge variant="destructive">Nota de Crédito</Badge>;
    default:
      return <Badge variant="outline">{type}</Badge>;
  }
};

export default function OrderDetail() {
  const navigate = useNavigate();
  const { orderId } = useParams<{ orderId: string }>();
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<Order | null>(null);
  const [documents, setDocuments] = useState<TaxDocument[]>([]);

  useEffect(() => {
    if (orderId) {
      fetchOrderDetails();
    }
  }, [orderId]);

  const fetchOrderDetails = async () => {
    try {
      // Fetch order
      const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) throw orderError;
      if (!orderData) {
        toast.error("Venta no encontrada");
        setLoading(false);
        return;
      }
      setOrder(orderData);

      // Fetch associated tax documents
      const { data: orderDocs, error: docsError } = await supabase
        .from("order_tax_documents")
        .select(`
          tax_documents (
            id,
            document_type,
            document_number,
            document_date,
            total_amount,
            client_name,
            client_tax_id,
            external_url
          )
        `)
        .eq("order_id", orderId);

      if (docsError) throw docsError;
      
      if (orderDocs && orderDocs.length > 0) {
        setDocuments(orderDocs.map((od: any) => od.tax_documents));
      }

    } catch (error) {
      console.error("Error fetching order details:", error);
      toast.error("Error al cargar detalles de la venta");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (!order) {
    return (
      <AppLayout>
        <div className="py-8">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Volver
          </Button>
          <p className="text-center text-muted-foreground mt-8">Venta no encontrada</p>
        </div>
      </AppLayout>
    );
  }

  const netAmount = order.net_amount || ((order.gross_amount || 0) - (order.commission_amount || 0) - (order.financing_fee || 0));

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Volver
          </Button>
        </div>

        {/* Order Summary Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Package className="h-6 w-6 text-muted-foreground" />
                <div>
                  <CardTitle>Venta #{order.external_sale_id}</CardTitle>
                  <CardDescription>
                    {order.marketplace} • {format(new Date(order.order_date), "dd MMMM yyyy, HH:mm", { locale: es })}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {getStatusBadge(order.status)}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Monto Bruto</p>
                <p className="text-xl font-bold">${(order.gross_amount || 0).toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Comisión</p>
                <p className="text-xl font-bold text-muted-foreground">-${(order.commission_amount || 0).toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Financiamiento</p>
                <p className="text-xl font-bold text-muted-foreground">-${(order.financing_fee || 0).toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Monto Neto</p>
                <p className="text-xl font-bold text-primary">${netAmount.toLocaleString("es-CL")}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Customer Info */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <User className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Cliente</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Nombre</p>
                <p className="font-medium">{order.customer_name}</p>
              </div>
              {order.customer_email && (
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="font-medium">{order.customer_email}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">RUT</p>
                <p className="font-medium font-mono">
                  {order.customer_tax_id ? formatRut(order.customer_tax_id) : <span className="text-muted-foreground">Consumidor Final</span>}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Payment Info */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Pago</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Método de Pago</p>
                <p className="font-medium">{order.payment_method || 'N/A'}</p>
              </div>
              {order.payment_method_brand && (
                <div>
                  <p className="text-sm text-muted-foreground">Tarjeta</p>
                  <p className="font-medium">{order.payment_method_brand}</p>
                </div>
              )}
              {order.installments && order.installments > 1 && (
                <div>
                  <p className="text-sm text-muted-foreground">Cuotas</p>
                  <p className="font-medium">{order.installments} cuotas</p>
                </div>
              )}
              {order.money_release_date && (
                <div>
                  <p className="text-sm text-muted-foreground">Fecha de Liberación</p>
                  <p className="font-medium">{format(new Date(order.money_release_date), "dd/MM/yyyy", { locale: es })}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Product Info */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Producto</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Título</p>
                <p className="font-medium">{order.product_title || 'N/A'}</p>
              </div>
              {order.seller_sku && (
                <div>
                  <p className="text-sm text-muted-foreground">SKU</p>
                  <p className="font-medium font-mono">{order.seller_sku}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">Cantidad</p>
                <p className="font-medium">{order.items} unidad(es)</p>
              </div>
              {order.shipping_cost !== null && order.shipping_cost > 0 && (
                <div>
                  <p className="text-sm text-muted-foreground">Costo de Envío</p>
                  <p className="font-medium">${order.shipping_cost.toLocaleString("es-CL")}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tax Documents */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Documentos Tributarios</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {documents.length > 0 ? (
                <div className="space-y-3">
                  {documents.map((doc) => (
                    <div key={doc.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <Receipt className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="flex items-center gap-2">
                            {getDocTypeBadge(doc.document_type)}
                            <span className="font-mono text-sm">#{doc.document_number}</span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {format(new Date(doc.document_date), "dd/MM/yyyy")} • ${doc.total_amount.toLocaleString("es-CL")}
                          </p>
                        </div>
                      </div>
                      {doc.external_url && (
                        <a 
                          href={doc.external_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">Sin documentos tributarios asociados</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
