import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle, AlertCircle, Link as LinkIcon, FileText, Plus } from "lucide-react";
import TaxDocumentDialog from "./TaxDocumentDialog";
import LinkTaxDocumentDialog from "./LinkTaxDocumentDialog";

interface Order {
  id: string;
  order_id: string;
  customer_name: string;
  order_date: string;
  amount: number;
  reconciliation_status: string;
  channel: string;
  gross_amount?: number;
  net_amount?: number;
  commission_percentage?: number;
  commission_amount?: number;
  payment_method?: string;
  expected_payment_date?: string;
  has_exact_data?: boolean;
  settlement_date?: string;
  settlement_amount?: number;
  shipping_cost?: number;
  discount_amount?: number;
  shipping_mode?: string;
}

interface Payment {
  id: string;
  payment_date: string;
  amount: number;
  reference: string | null;
  bank: string | null;
}

interface Reconciliation {
  payment_id: string;
  reconciliation_type: string;
  confidence_score?: number;
  status?: string;
  payments: Payment;
}

interface ReconciliationTableProps {
  orders: (Order & { reconciliations?: Reconciliation[] })[];
  onManualReconcile: (orderId: string) => void;
  onEditInvoiceData: (orderId: string) => void;
}

export const ReconciliationTable = ({ orders, onManualReconcile, onEditInvoiceData }: ReconciliationTableProps) => {
  const [selectedOrderForTaxDoc, setSelectedOrderForTaxDoc] = useState<Order | null>(null);
  const [showTaxDocDialog, setShowTaxDocDialog] = useState(false);
  const [showLinkTaxDocDialog, setShowLinkTaxDocDialog] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'reconciled':
        return (
          <Badge className="gap-1 bg-green-500 hover:bg-green-600">
            <CheckCircle className="h-3 w-3" />
            Conciliado
          </Badge>
        );
      case 'partially_reconciled':
        return (
          <Badge className="gap-1 bg-yellow-500 hover:bg-yellow-600">
            <AlertCircle className="h-3 w-3" />
            Revisar
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            Pendiente
          </Badge>
        );
    }
  };

  const getConfidenceBadge = (score: number) => {
    if (score >= 80) {
      return <Badge className="bg-green-600 hover:bg-green-700">{score}%</Badge>;
    } else if (score >= 65) {
      return <Badge className="bg-yellow-600 hover:bg-yellow-700">{score}%</Badge>;
    } else {
      return <Badge variant="destructive">{score}%</Badge>;
    }
  };

  const getDataTypeBadge = (hasExactData?: boolean) => {
    if (hasExactData) {
      return (
        <Badge className="gap-1 bg-blue-600 hover:bg-blue-700 text-white">
          <CheckCircle className="h-3 w-3" />
          Datos Exactos
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 text-orange-600 border-orange-300">
        <AlertCircle className="h-3 w-3" />
        Datos Estimados
      </Badge>
    );
  };

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID Orden</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead>Fecha</TableHead>
            <TableHead className="text-right">Monto</TableHead>
            <TableHead>Fecha Pago Esperada</TableHead>
            <TableHead>Canal</TableHead>
            <TableHead>Tipo de Datos</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Confianza</TableHead>
            <TableHead>Pago Asociado</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={11} className="text-center text-muted-foreground">
                No hay órdenes para mostrar
              </TableCell>
            </TableRow>
          ) : (
            orders.map((order) => {
              const reconciliation = order.reconciliations?.[0];
              const payment = reconciliation?.payments;

              return (
                <TableRow key={order.id}>
                  <TableCell className="font-medium">{order.order_id}</TableCell>
                  <TableCell>{order.customer_name}</TableCell>
                  <TableCell>
                    {new Date(order.order_date).toLocaleDateString('es-AR')}
                  </TableCell>
                  <TableCell className="text-right">
                    {order.channel === 'meli' && order.net_amount ? (
                      <div className="flex flex-col text-xs space-y-1">
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Bruto:</span>
                          <span className="font-medium">${order.gross_amount?.toLocaleString('es-AR')}</span>
                        </div>
                        {order.discount_amount > 0 && (
                          <div className="flex justify-between gap-2">
                            <span className="text-muted-foreground text-[10px]">Descuento:</span>
                            <span className="text-[10px] text-red-600">
                              -${order.discount_amount?.toLocaleString('es-AR')}
                            </span>
                          </div>
                        )}
                        {order.shipping_cost > 0 && order.shipping_mode === 'me2' && (
                          <div className="flex justify-between gap-2">
                            <span className="text-muted-foreground text-[10px]">Envío ME:</span>
                            <span className="text-[10px] text-red-600">
                              -${order.shipping_cost?.toLocaleString('es-AR')}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground text-[10px]">Comisión:</span>
                          <span className="text-[10px] text-red-600">
                            -{order.commission_percentage?.toFixed(2)}% (${order.commission_amount?.toLocaleString('es-AR')})
                          </span>
                        </div>
                        <div className="flex justify-between gap-2 pt-1 border-t">
                          <span className="text-muted-foreground font-medium">Neto:</span>
                          <span className="font-semibold text-green-600">
                            ${order.net_amount?.toLocaleString('es-AR')}
                          </span>
                        </div>
                        {order.settlement_amount && (
                          <div className="flex justify-between gap-2 pt-1 border-t">
                            <span className="text-muted-foreground font-bold">En Banco:</span>
                            <span className="font-bold text-blue-600">
                              ${order.settlement_amount?.toLocaleString('es-AR')}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span>${Number(order.amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {order.settlement_date || order.expected_payment_date ? (
                      <div className="flex flex-col">
                        <span>
                          {new Date(order.settlement_date || order.expected_payment_date).toLocaleDateString('es-AR')}
                        </span>
                        {order.settlement_date && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 w-fit mt-1">
                            Fecha exacta
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{order.channel}</Badge>
                  </TableCell>
                  <TableCell>{getDataTypeBadge(order.has_exact_data)}</TableCell>
                  <TableCell>{getStatusBadge(order.reconciliation_status)}</TableCell>
                  <TableCell>
                    {reconciliation?.confidence_score ? 
                      getConfidenceBadge(reconciliation.confidence_score) : 
                      <span className="text-muted-foreground text-sm">-</span>
                    }
                  </TableCell>
                  <TableCell>
                    {payment ? (
                      <div className="flex items-center gap-2">
                        <LinkIcon className="h-4 w-4 text-muted-foreground" />
                        <div className="text-sm">
                          <div className="font-medium">
                            ${Number(payment.amount).toLocaleString('es-AR')}
                          </div>
                          <div className="text-muted-foreground">
                            {new Date(payment.payment_date).toLocaleDateString('es-AR')}
                          </div>
                          {payment.reference && (
                            <div className="text-xs text-muted-foreground">
                              {payment.reference}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      {order.reconciliation_status === 'pending' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onManualReconcile(order.id)}
                        >
                          Conciliar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onEditInvoiceData(order.id)}
                      >
                        <FileText className="h-4 w-4 mr-1" />
                        Fiscal
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedOrderForTaxDoc(order);
                          setShowLinkTaxDocDialog(true);
                        }}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Doc. Tributario
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {selectedOrderForTaxDoc && (
        <>
          <TaxDocumentDialog
            open={showTaxDocDialog}
            onOpenChange={setShowTaxDocDialog}
            orderId={selectedOrderForTaxDoc.id}
            onSuccess={() => {
              setRefreshKey(prev => prev + 1);
              window.location.reload();
            }}
          />
          <LinkTaxDocumentDialog
            open={showLinkTaxDocDialog}
            onOpenChange={setShowLinkTaxDocDialog}
            orderId={selectedOrderForTaxDoc.id}
            orderAmount={selectedOrderForTaxDoc.amount}
            onSuccess={() => {
              setRefreshKey(prev => prev + 1);
              window.location.reload();
            }}
            onCreateNew={() => {
              setShowLinkTaxDocDialog(false);
              setShowTaxDocDialog(true);
            }}
          />
        </>
      )}
    </div>
  );
};