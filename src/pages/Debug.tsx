import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Package, FileText, GitCompare, Copy, Terminal, ChevronDown, Search, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

type DebugTab = 'ml' | 'bsale' | 'compare';

interface DebugOrder {
  id: string;
  order_id: string;
  order_date: string;
  gross_amount: number | null;
  customer_name: string;
  customer_tax_id: string | null;
  raw_data: Record<string, any> | null;
}

interface DebugTaxDoc {
  id: string;
  document_number: string;
  document_type: string;
  document_date: string;
  total_amount: number;
  client_name: string | null;
  client_tax_id: string | null;
  raw_data: Record<string, any> | null;
}

// Extractors for key fields
const extractMeliKeyFields = (raw: Record<string, any> | null) => {
  if (!raw) return null;
  return {
    orderId: raw.id,
    packId: raw.pack_id,
    status: raw.status,
    buyerId: raw.buyer?.id,
    buyerNickname: raw.buyer?.nickname,
    buyerBillingDocType: raw.buyer?.billing_info?.doc_type,
    buyerBillingDocNumber: raw.buyer?.billing_info?.doc_number,
    paymentId: raw.payments?.[0]?.id,
    paymentType: raw.payments?.[0]?.payment_type,
    transactionAmount: raw.payments?.[0]?.transaction_amount,
    dateApproved: raw.payments?.[0]?.date_approved,
    saleFee: raw.order_items?.[0]?.sale_fee,
    shippingId: raw.shipping?.id,
    paidAmount: raw.paid_amount,
    totalAmount: raw.total_amount,
  };
};

const extractBsaleKeyFields = (raw: Record<string, any> | null) => {
  if (!raw) return null;
  return {
    documentId: raw.id,
    number: raw.number,
    typeName: raw.typeName,
    codeSii: raw.codeSii,
    emissionDate: raw.emissionDate ? new Date(raw.emissionDate * 1000).toISOString().split('T')[0] : null,
    officeId: raw.office?.id,
    officeName: raw.office?.name,
    clientId: raw.client?.id,
    clientCode: raw.client?.code,
    clientName: raw.client?.firstName,
    clientNote: raw.clientNote,
    detailsCount: raw.details?.length || 0,
    detailsSum: raw.details?.reduce((sum: number, d: any) => sum + ((d.netAmount || 0) * (d.quantity || 1)), 0) || 0,
    netAmount: raw.netAmount,
    taxAmount: raw.taxAmount,
    totalAmount: raw.totalAmount,
  };
};

const formatCurrency = (amount: number | null | undefined) => {
  if (amount == null) return '-';
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
};

const normalizeRut = (rut: string | null | undefined): string => {
  if (!rut) return '';
  return rut.replace(/[.\-]/g, '').replace(/k$/i, 'K').toUpperCase();
};

const KeyValueRow = ({ label, value, mono = false }: { label: string; value: any; mono?: boolean }) => (
  <div className="flex justify-between py-1 border-b border-border/50 last:border-0">
    <span className="text-muted-foreground text-sm">{label}</span>
    <span className={`text-sm ${mono ? 'font-mono' : ''}`}>{value ?? '-'}</span>
  </div>
);

const RawJsonViewer = ({ data, title }: { data: Record<string, any> | null; title: string }) => {
  const [isOpen, setIsOpen] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    toast.success("JSON copiado al clipboard");
  };

  const logToConsole = () => {
    console.log(`[Debug] ${title}:`, data);
    toast.success("JSON enviado a la consola (F12)");
  };

  if (!data) return <p className="text-muted-foreground text-sm">Sin datos raw</p>;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center justify-between">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2">
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            RAW JSON
          </Button>
        </CollapsibleTrigger>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={copyToClipboard}>
            <Copy className="h-4 w-4 mr-1" /> Copiar
          </Button>
          <Button variant="outline" size="sm" onClick={logToConsole}>
            <Terminal className="h-4 w-4 mr-1" /> Consola
          </Button>
        </div>
      </div>
      <CollapsibleContent>
        <pre className="mt-2 p-4 bg-muted rounded-md overflow-auto max-h-96 text-xs font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
};

const MeliOrderCard = ({ order }: { order: DebugOrder }) => {
  const keyFields = extractMeliKeyFields(order.raw_data);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Order: {order.order_id}
          </CardTitle>
          <div className="flex items-center gap-2">
            {order.customer_tax_id && (
              <Badge variant="secondary" className="font-mono">
                RUT: {order.customer_tax_id}
              </Badge>
            )}
            <Badge variant="outline">{formatCurrency(order.gross_amount)}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h4 className="font-medium text-sm mb-2">Campos DB</h4>
            <KeyValueRow label="order_id" value={order.order_id} mono />
            <KeyValueRow label="order_date" value={format(new Date(order.order_date), 'dd/MM/yyyy HH:mm')} />
            <KeyValueRow label="gross_amount" value={formatCurrency(order.gross_amount)} />
            <KeyValueRow label="customer_name" value={order.customer_name} />
            <KeyValueRow label="customer_tax_id" value={order.customer_tax_id} mono />
          </div>
          {keyFields && (
            <div>
              <h4 className="font-medium text-sm mb-2">Campos Raw (ML API)</h4>
              <KeyValueRow label="pack_id" value={keyFields.packId} mono />
              <KeyValueRow label="status" value={keyFields.status} />
              <KeyValueRow label="buyer.id" value={keyFields.buyerId} mono />
              <KeyValueRow label="buyer.nickname" value={keyFields.buyerNickname} />
              <KeyValueRow label="billing_info.doc_type" value={keyFields.buyerBillingDocType} />
              <KeyValueRow label="billing_info.doc_number" value={keyFields.buyerBillingDocNumber} mono />
              <KeyValueRow label="payments[0].id" value={keyFields.paymentId} mono />
              <KeyValueRow label="payments[0].type" value={keyFields.paymentType} />
              <KeyValueRow label="transaction_amount" value={formatCurrency(keyFields.transactionAmount)} />
              <KeyValueRow label="paid_amount" value={formatCurrency(keyFields.paidAmount)} />
            </div>
          )}
        </div>
        <RawJsonViewer data={order.raw_data} title={`Order ${order.order_id}`} />
      </CardContent>
    </Card>
  );
};

const BsaleDocCard = ({ doc }: { doc: DebugTaxDoc }) => {
  const keyFields = extractBsaleKeyFields(doc.raw_data);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {doc.document_type}: #{doc.document_number}
          </CardTitle>
          <Badge variant="outline">{formatCurrency(doc.total_amount)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h4 className="font-medium text-sm mb-2">Campos DB</h4>
            <KeyValueRow label="document_number" value={doc.document_number} mono />
            <KeyValueRow label="document_type" value={doc.document_type} />
            <KeyValueRow label="document_date" value={doc.document_date} />
            <KeyValueRow label="total_amount" value={formatCurrency(doc.total_amount)} />
            <KeyValueRow label="client_name" value={doc.client_name} />
            <KeyValueRow label="client_tax_id" value={doc.client_tax_id} mono />
          </div>
          {keyFields && (
            <div>
              <h4 className="font-medium text-sm mb-2">Campos Raw (Bsale API)</h4>
              <KeyValueRow label="id" value={keyFields.documentId} mono />
              <KeyValueRow label="typeName" value={keyFields.typeName} />
              <KeyValueRow label="codeSii" value={keyFields.codeSii || '(vacío)'} />
              <KeyValueRow label="emissionDate" value={keyFields.emissionDate} />
              <KeyValueRow label="office.name" value={keyFields.officeName} />
              <KeyValueRow label="client.code" value={keyFields.clientCode} mono />
              <KeyValueRow label="client.firstName" value={keyFields.clientName} />
              <KeyValueRow label="clientNote" value={keyFields.clientNote || '(vacío)'} />
              <KeyValueRow label="details.count" value={keyFields.detailsCount} />
              <KeyValueRow label="netAmount" value={formatCurrency(keyFields.netAmount)} />
              <KeyValueRow label="taxAmount" value={formatCurrency(keyFields.taxAmount)} />
              <KeyValueRow label="totalAmount (raw)" value={formatCurrency(keyFields.totalAmount)} />
            </div>
          )}
        </div>
        <RawJsonViewer data={doc.raw_data} title={`Doc ${doc.document_number}`} />
      </CardContent>
    </Card>
  );
};

const ComparePanel = ({ 
  orders, 
  docs, 
  selectedOrder, 
  selectedDoc, 
  onSelectOrder, 
  onSelectDoc 
}: { 
  orders: DebugOrder[];
  docs: DebugTaxDoc[];
  selectedOrder: DebugOrder | null;
  selectedDoc: DebugTaxDoc | null;
  onSelectOrder: (order: DebugOrder | null) => void;
  onSelectDoc: (doc: DebugTaxDoc | null) => void;
}) => {
  const orderKeyFields = selectedOrder ? extractMeliKeyFields(selectedOrder.raw_data) : null;
  const docKeyFields = selectedDoc ? extractBsaleKeyFields(selectedDoc.raw_data) : null;

  const compareRut = () => {
    if (!selectedOrder || !selectedDoc) return null;
    const orderRut = normalizeRut(selectedOrder.customer_tax_id);
    const docRut = normalizeRut(selectedDoc.client_tax_id);
    if (!orderRut || !docRut) return { match: false, icon: AlertTriangle, color: 'text-yellow-500', text: 'Sin RUT para comparar' };
    if (orderRut === docRut) return { match: true, icon: CheckCircle2, color: 'text-green-500', text: 'RUT coincide' };
    return { match: false, icon: XCircle, color: 'text-red-500', text: `No coincide: ${orderRut} vs ${docRut}` };
  };

  const compareAmount = () => {
    if (!selectedOrder || !selectedDoc) return null;
    const orderAmount = selectedOrder.gross_amount || 0;
    const docAmount = selectedDoc.total_amount || 0;
    const diff = Math.abs(orderAmount - docAmount);
    const percentDiff = orderAmount > 0 ? (diff / orderAmount) * 100 : 0;
    
    if (diff === 0) return { match: true, icon: CheckCircle2, color: 'text-green-500', text: 'Monto exacto' };
    if (diff <= 500) return { match: true, icon: CheckCircle2, color: 'text-green-500', text: `Diferencia: ${formatCurrency(diff)} (${percentDiff.toFixed(1)}%)` };
    return { match: false, icon: XCircle, color: 'text-red-500', text: `Diferencia: ${formatCurrency(diff)} (${percentDiff.toFixed(1)}%)` };
  };

  const compareDate = () => {
    if (!selectedOrder || !selectedDoc) return null;
    const orderDate = new Date(selectedOrder.order_date).toISOString().split('T')[0];
    const docDate = selectedDoc.document_date;
    
    if (orderDate === docDate) return { match: true, icon: CheckCircle2, color: 'text-green-500', text: 'Fecha exacta' };
    
    const daysDiff = Math.abs((new Date(orderDate).getTime() - new Date(docDate).getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff <= 2) return { match: true, icon: CheckCircle2, color: 'text-green-500', text: `Diferencia: ${daysDiff.toFixed(0)} día(s)` };
    return { match: false, icon: AlertTriangle, color: 'text-yellow-500', text: `Diferencia: ${daysDiff.toFixed(0)} días` };
  };

  const calculateScore = () => {
    let score = 0;
    const rutResult = compareRut();
    const amountResult = compareAmount();
    const dateResult = compareDate();
    
    if (rutResult?.match) score += 40;
    if (amountResult?.match) score += 30;
    if (dateResult?.match) score += 20;
    
    return score;
  };

  const rutResult = compareRut();
  const amountResult = compareAmount();
  const dateResult = compareDate();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium mb-2 block">Seleccionar Orden ML</label>
          <Select 
            value={selectedOrder?.id || ''} 
            onValueChange={(v) => onSelectOrder(orders.find(o => o.id === v) || null)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Seleccionar orden..." />
            </SelectTrigger>
            <SelectContent>
              {orders.map(order => (
                <SelectItem key={order.id} value={order.id}>
                  {order.order_id} - {formatCurrency(order.gross_amount)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm font-medium mb-2 block">Seleccionar Documento Bsale</label>
          <Select 
            value={selectedDoc?.id || ''} 
            onValueChange={(v) => onSelectDoc(docs.find(d => d.id === v) || null)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Seleccionar documento..." />
            </SelectTrigger>
            <SelectContent>
              {docs.map(doc => (
                <SelectItem key={doc.id} value={doc.id}>
                  {doc.document_type} #{doc.document_number} - {formatCurrency(doc.total_amount)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {selectedOrder && selectedDoc && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Orden ML: {selectedOrder.order_id}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KeyValueRow label="Monto" value={formatCurrency(selectedOrder.gross_amount)} />
                <KeyValueRow label="RUT" value={selectedOrder.customer_tax_id} mono />
                <KeyValueRow label="Fecha" value={format(new Date(selectedOrder.order_date), 'dd/MM/yyyy')} />
                <KeyValueRow label="Cliente" value={selectedOrder.customer_name} />
                {orderKeyFields && (
                  <>
                    <KeyValueRow label="pack_id" value={orderKeyFields.packId} mono />
                    <KeyValueRow label="billing_doc" value={orderKeyFields.buyerBillingDocNumber} mono />
                  </>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  {selectedDoc.document_type}: #{selectedDoc.document_number}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KeyValueRow label="Total" value={formatCurrency(selectedDoc.total_amount)} />
                <KeyValueRow label="RUT" value={selectedDoc.client_tax_id} mono />
                <KeyValueRow label="Fecha" value={selectedDoc.document_date} />
                <KeyValueRow label="Cliente" value={selectedDoc.client_name} />
                {docKeyFields && (
                  <>
                    <KeyValueRow label="codeSii" value={docKeyFields.codeSii || '(vacío)'} />
                    <KeyValueRow label="clientNote" value={docKeyFields.clientNote || '(vacío)'} />
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Análisis de Match</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {rutResult && (
                <div className="flex items-center gap-2">
                  <rutResult.icon className={`h-4 w-4 ${rutResult.color}`} />
                  <span className="text-sm">RUT: {rutResult.text}</span>
                </div>
              )}
              {amountResult && (
                <div className="flex items-center gap-2">
                  <amountResult.icon className={`h-4 w-4 ${amountResult.color}`} />
                  <span className="text-sm">Monto: {amountResult.text}</span>
                </div>
              )}
              {dateResult && (
                <div className="flex items-center gap-2">
                  <dateResult.icon className={`h-4 w-4 ${dateResult.color}`} />
                  <span className="text-sm">Fecha: {dateResult.text}</span>
                </div>
              )}
              <div className="pt-2 border-t">
                <span className="font-medium">Score Estimado: {calculateScore()}/100</span>
                {calculateScore() >= 85 && <Badge className="ml-2" variant="default">Auto-Link</Badge>}
                {calculateScore() >= 70 && calculateScore() < 85 && <Badge className="ml-2" variant="secondary">Posible</Badge>}
                {calculateScore() < 70 && <Badge className="ml-2" variant="destructive">No Match</Badge>}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

export default function Debug() {
  const [activeTab, setActiveTab] = useState<DebugTab>('ml');
  const [mlSearch, setMlSearch] = useState('');
  const [bsaleSearch, setBsaleSearch] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<DebugOrder | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DebugTaxDoc | null>(null);

  const { data: orders = [], isLoading: loadingOrders } = useQuery({
    queryKey: ['debug-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_id, order_date, gross_amount, customer_name, customer_tax_id, raw_data')
        .order('order_date', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      return data as DebugOrder[];
    },
  });

  const { data: taxDocs = [], isLoading: loadingDocs } = useQuery({
    queryKey: ['debug-tax-docs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tax_documents')
        .select('id, document_number, document_type, document_date, total_amount, client_name, client_tax_id, raw_data')
        .order('document_date', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      return data as DebugTaxDoc[];
    },
  });

  const filteredOrders = orders.filter(order => {
    if (!mlSearch) return true;
    const search = mlSearch.toLowerCase();
    return (
      order.order_id?.toLowerCase().includes(search) ||
      order.customer_name?.toLowerCase().includes(search) ||
      order.customer_tax_id?.toLowerCase().includes(search)
    );
  });

  const filteredDocs = taxDocs.filter(doc => {
    if (!bsaleSearch) return true;
    const search = bsaleSearch.toLowerCase();
    return (
      doc.document_number?.toLowerCase().includes(search) ||
      doc.client_name?.toLowerCase().includes(search) ||
      doc.client_tax_id?.toLowerCase().includes(search)
    );
  });

  return (
    <AppLayout>
      <div className="container py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Debug Data</h1>
          <p className="text-muted-foreground">Inspección de datos raw de MercadoLibre y Bsale</p>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DebugTab)}>
          <TabsList>
            <TabsTrigger value="ml" className="gap-2">
              <Package className="h-4 w-4" />
              MercadoLibre ({orders.length})
            </TabsTrigger>
            <TabsTrigger value="bsale" className="gap-2">
              <FileText className="h-4 w-4" />
              Bsale ({taxDocs.length})
            </TabsTrigger>
            <TabsTrigger value="compare" className="gap-2">
              <GitCompare className="h-4 w-4" />
              Comparador
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ml" className="space-y-4">
            <div className="flex gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por Order ID, nombre, RUT..."
                  value={mlSearch}
                  onChange={(e) => setMlSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {loadingOrders ? (
              <p className="text-muted-foreground">Cargando órdenes...</p>
            ) : filteredOrders.length === 0 ? (
              <p className="text-muted-foreground">No se encontraron órdenes</p>
            ) : (
              filteredOrders.map(order => (
                <MeliOrderCard key={order.id} order={order} />
              ))
            )}
          </TabsContent>

          <TabsContent value="bsale" className="space-y-4">
            <div className="flex gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por número, nombre, RUT..."
                  value={bsaleSearch}
                  onChange={(e) => setBsaleSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {loadingDocs ? (
              <p className="text-muted-foreground">Cargando documentos...</p>
            ) : filteredDocs.length === 0 ? (
              <p className="text-muted-foreground">No se encontraron documentos</p>
            ) : (
              filteredDocs.map(doc => (
                <BsaleDocCard key={doc.id} doc={doc} />
              ))
            )}
          </TabsContent>

          <TabsContent value="compare">
            <ComparePanel
              orders={orders}
              docs={taxDocs}
              selectedOrder={selectedOrder}
              selectedDoc={selectedDoc}
              onSelectOrder={setSelectedOrder}
              onSelectDoc={setSelectedDoc}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
