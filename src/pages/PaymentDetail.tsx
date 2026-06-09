import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, ExternalLink, Store, CreditCard, Building2, Wallet, Landmark } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";

// Channel configuration
const CHANNEL_CONFIG: Record<string, { icon: typeof Store; label: string }> = {
  'MERCADOPAGO': { icon: Store, label: 'MercadoLibre' },
  'STRIPE': { icon: CreditCard, label: 'Shopify' },
  'SANTANDER': { icon: Building2, label: 'Falabella' },
  'WEBPAY': { icon: Landmark, label: 'WebPay' },
};

const getChannelInfo = (provider: string) => {
  return CHANNEL_CONFIG[provider] || { icon: Wallet, label: provider || 'Otro' };
};

// Validate Chilean RUT using modulo 11 algorithm
const isValidRut = (rut: string): boolean => {
  const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2) return false;
  
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  
  // Calculate expected DV
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const expectedDv = 11 - (sum % 11);
  const expectedDvChar = expectedDv === 11 ? '0' : expectedDv === 10 ? 'K' : expectedDv.toString();
  
  return dv === expectedDvChar;
};

// Format RUT: solo números del cuerpo, sin DV, sin puntos ni guión
const formatRut = (rut: string): string => {
  const clean = rut.replace(/[^0-9kK]/g, '');
  if (clean.length < 2) return rut; // Return raw if invalid
  // Solo el cuerpo del RUT, sin dígito verificador
  return clean.slice(0, -1);
};

interface Payment {
  id: string;
  payment_provider: string;
  external_payment_id: string | null;
  payment_date: string;
  net_amount: number;
  gross_amount: number;
  fees_amount: number;
  status: string;
}

interface Sale {
  id: string;
  order_id: string;
  marketplace: string;
  external_sale_id: string;
  order_date: string;
  gross_amount: number;
  commission_amount: number | null;
  customer_name: string;
  customer_tax_id: string | null;
  sale_status: string;
  status: string;
  allocated_amount: number;
  hasNotaCredito?: boolean;
}

interface Document {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  total_amount: number;
  client_name: string | null;
  client_tax_id: string | null;
  external_url: string | null;
}

export default function PaymentDetail() {
  const navigate = useNavigate();
  const { paymentId } = useParams<{ paymentId: string }>();
  const [loading, setLoading] = useState(true);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [documents, setDocuments] = useState<Map<string, Document[]>>(new Map());

  useEffect(() => {
    if (paymentId) {
      fetchPaymentDetails();
    }
  }, [paymentId]);

  const fetchPaymentDetails = async () => {
    try {
      // Fetch payment
      const { data: paymentData, error: paymentError } = await supabase
        .from("payments")
        .select("*")
        .eq("id", paymentId)
        .single();

      if (paymentError) throw paymentError;
      setPayment(paymentData);

      // Fetch associated sales through payment_sales
      const { data: paymentSales, error: salesError } = await supabase
        .from("payment_sales")
        .select(`
          allocated_amount,
          sale_id,
        orders!payment_sales_sale_id_fkey (
            id,
            order_id,
            marketplace,
            external_sale_id,
            order_date,
            gross_amount,
            commission_amount,
            customer_name,
            customer_tax_id,
            sale_status,
            status
          )
        `)
        .eq("payment_id", paymentId);

      if (salesError) throw salesError;

      const mappedSales: Sale[] = (paymentSales || []).map((ps: any) => ({
        id: ps.orders.id,
        order_id: ps.orders.order_id,
        marketplace: ps.orders.marketplace,
        external_sale_id: ps.orders.external_sale_id,
        order_date: ps.orders.order_date,
        gross_amount: ps.orders.gross_amount,
        commission_amount: ps.orders.commission_amount,
        customer_name: ps.orders.customer_name,
        customer_tax_id: ps.orders.customer_tax_id,
        sale_status: ps.orders.sale_status,
        status: ps.orders.status,
        allocated_amount: ps.allocated_amount,
      }));

      setSales(mappedSales);

      // Fetch documents for each sale - including client_tax_id and NC detection
      const docsMap = new Map<string, Document[]>();
      const salesWithNC = new Set<string>();
      
      for (const sale of mappedSales) {
        const { data: orderDocs } = await supabase
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
          .eq("order_id", sale.id);

        if (orderDocs && orderDocs.length > 0) {
          const docs = orderDocs.map((od: any) => od.tax_documents);
          docsMap.set(sale.id, docs);
          // Detect if has NC
          if (docs.some((d: Document) => d.document_type === 'nota_credito')) {
            salesWithNC.add(sale.id);
          }
        }
      }
      setDocuments(docsMap);
      
      // Update sales with NC info
      setSales(prev => prev.map(s => ({
        ...s,
        hasNotaCredito: salesWithNC.has(s.id)
      })));

    } catch (error) {
      console.error("Error fetching payment details:", error);
      toast.error("Error al cargar detalles de la liquidación");
    } finally {
      setLoading(false);
    }
  };

  // Get RUT display - priority from tax document, fallback to order, then "Consumidor Final"
  const getRutDisplay = (sale: Sale, saleDocs: Document[]) => {
    // Priority 1: RUT from tax document
    const docWithRut = saleDocs.find(d => d.client_tax_id);
    if (docWithRut?.client_tax_id) {
      return formatRut(docWithRut.client_tax_id);
    }
    
    // Priority 2: RUT from order
    if (sale.customer_tax_id) {
      return formatRut(sale.customer_tax_id);
    }
    
    // Fallback
    return <span className="text-muted-foreground">Consumidor Final</span>;
  };

  const getDocTypeBadge = (type: string) => {
    switch (type) {
      case 'boleta':
        return <Badge variant="default">Boleta</Badge>;
      case 'factura':
        return <Badge variant="secondary">Factura</Badge>;
      case 'nota_credito':
        return <Badge variant="destructive">NC</Badge>;
      default:
        return <Badge variant="outline">{type}</Badge>;
    }
  };

  // Badge for refund status
  const getRefundStatusBadge = (sale: Sale) => {
    if (sale.status !== 'cancelled') return null;
    
    if (sale.hasNotaCredito) {
      return <span title="Devuelta con Nota de Crédito">🟢</span>;
    }
    return <span title="Devuelta sin Nota de Crédito">🔴</span>;
  };

  // Calculate conciliation status
  const getConciliationStatus = () => {
    if (sales.length === 0) return { icon: '—', text: 'Sin ventas' };
    const salesWithoutDoc = sales.filter(s => !documents.has(s.id) || documents.get(s.id)?.length === 0);
    if (salesWithoutDoc.length === 0) {
      return { icon: '🟢', text: 'Conciliada' };
    }
    return { icon: '🔴', text: `${salesWithoutDoc.length} sin documento` };
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

  if (!payment) {
    return (
      <AppLayout>
        <div className="py-8">
          <Button variant="ghost" onClick={() => navigate("/payments")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Volver
          </Button>
          <p className="text-center text-muted-foreground mt-8">Liquidación no encontrada</p>
        </div>
      </AppLayout>
    );
  }

  const channelInfo = getChannelInfo(payment.payment_provider);
  const ChannelIcon = channelInfo.icon;
  const conciliation = getConciliationStatus();
  const totalAllocated = sales.reduce((sum, s) => sum + s.allocated_amount, 0);
  const difference = payment.net_amount - totalAllocated;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/payments")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Volver
          </Button>
        </div>

        {/* Payment Summary Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ChannelIcon className="h-6 w-6 text-muted-foreground" />
                <div>
                  <CardTitle>Liquidación #{payment.external_payment_id || payment.id.slice(0, 8)}</CardTitle>
                <CardDescription>
                    {channelInfo.label} • {payment.payment_provider} • {format(new Date(payment.payment_date), "dd MMMM yyyy", { locale: es })}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-lg">{conciliation.icon}</span>
                <span className="text-sm text-muted-foreground">{conciliation.text}</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Monto Bruto</p>
                <p className="text-xl font-bold">${payment.gross_amount.toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Comisiones</p>
                <p className="text-xl font-bold text-muted-foreground">-${payment.fees_amount.toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Monto Neto</p>
                <p className="text-xl font-bold text-primary">${payment.net_amount.toLocaleString("es-CL")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Diferencia</p>
                <p className={`text-xl font-bold ${Math.abs(difference) < 1 ? 'text-muted-foreground' : 'text-amber-600'}`}>
                  ${difference.toLocaleString("es-CL")}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Associated Sales */}
        <Card>
          <CardHeader>
            <CardTitle>Ventas que componen este pago ({sales.length})</CardTitle>
            <CardDescription>
              Detalle de ventas incluidas en esta liquidación
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID Venta</TableHead>
                    <TableHead>Fecha Venta</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>RUT</TableHead>
                    <TableHead className="text-right">Bruto</TableHead>
                    <TableHead className="text-right">Comisión</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                    <TableHead>Documento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.map((sale) => {
                    const saleDocs = documents.get(sale.id) || [];
                    const refundBadge = getRefundStatusBadge(sale);
                    return (
                      <TableRow 
                        key={sale.id} 
                        className={`cursor-pointer hover:bg-muted/50 ${sale.status === 'cancelled' ? 'bg-muted/30' : ''}`}
                        onClick={() => navigate(`/orders/${sale.id}`)}
                      >
                        <TableCell className="font-mono text-sm">
                          <div className="flex items-center gap-2">
                            {sale.order_id || sale.external_sale_id || sale.id.slice(0, 8)}
                            {refundBadge}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(sale.order_date), "dd/MM/yy")}
                        </TableCell>
                        <TableCell>{sale.customer_name}</TableCell>
                        <TableCell className="font-mono text-sm">
                          {getRutDisplay(sale, saleDocs)}
                        </TableCell>
                        <TableCell className="text-right">
                          ${sale.gross_amount.toLocaleString("es-CL")}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          -${(sale.commission_amount || 0).toLocaleString("es-CL")}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          ${sale.allocated_amount.toLocaleString("es-CL")}
                        </TableCell>
                        <TableCell>
                          {saleDocs.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {saleDocs.map((doc) => (
                                <div key={doc.id} className="flex items-center gap-2">
                                  <span className="text-sm">🧾</span>
                                  {getDocTypeBadge(doc.document_type)}
                                  <span className="text-sm font-mono">#{doc.document_number}</span>
                                  {doc.external_url && (
                                    <a 
                                      href={doc.external_url} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="text-primary hover:underline"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">
                              Sin documento
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {sales.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        No hay ventas asociadas a esta liquidación
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}