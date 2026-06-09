import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { Package, TrendingDown, DollarSign, CheckCircle, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Types
interface SaleRow {
  id: string;
  orderId: string;  // MercadoLibre order ID
  externalSaleId: string | null;
  orderDate: string;
  customerName: string;
  rut: string | null;
  grossAmount: number;
  fees: number;
  netAmount: number;
  moneyReleaseDate: string | null;
  status: string;
  hasPayment: boolean;
  hasDocument: boolean;
  documentType: string | null;
  documentNumber: string | null;
}

interface SalesStats {
  totalGross: number;
  totalFees: number;
  totalNet: number;
  paidCount: number;
  totalCount: number;
  withoutDocCount: number;
}

type SalesFilter = 'all' | 'paid' | 'pending' | 'without_doc' | 'cancelled';

// Helpers
const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatRut = (rut: string | null): string => {
  if (!rut) return "—";
  // Extract only numeric body (no dots, dash, or verification digit)
  const cleaned = rut.replace(/\./g, '').replace(/-/g, '');
  // Remove last character (verification digit) if present
  return cleaned.length > 1 ? cleaned.slice(0, -1) : cleaned;
};

const getPaidStatus = (sale: SaleRow): { icon: string; label: string; variant: "default" | "secondary" | "destructive" | "outline" } => {
  if (sale.status === 'cancelled') {
    return { icon: '↩️', label: 'Cancelada', variant: 'outline' };
  }
  if (sale.hasPayment) {
    return { icon: '🟢', label: 'Pagado', variant: 'default' };
  }
  const today = new Date();
  if (sale.moneyReleaseDate && new Date(sale.moneyReleaseDate) <= today) {
    return { icon: '🟡', label: 'Por sincronizar', variant: 'secondary' };
  }
  return { icon: '🟡', label: 'Retenido', variant: 'secondary' };
};

const getDocumentBadge = (sale: SaleRow): { label: string; variant: "default" | "destructive" | "outline" } => {
  if (!sale.hasDocument) {
    return { label: 'Sin documento', variant: 'destructive' };
  }
  const typeLabel = sale.documentType === 'boleta' ? 'Boleta' : 
                    sale.documentType === 'factura' ? 'Factura' :
                    sale.documentType === 'nota_credito' ? 'NC' : 
                    sale.documentType || 'Doc';
  return { label: `${typeLabel} #${sale.documentNumber || '?'}`, variant: 'outline' };
};

// Period options (last 12 months)
const generatePeriodOptions = () => {
  const options = [];
  for (let i = 0; i < 12; i++) {
    const date = subMonths(new Date(), i);
    const value = format(date, 'yyyy-MM');
    const label = format(date, 'MMMM yyyy', { locale: es });
    options.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return options;
};

const Sales = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  
  // State
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [stats, setStats] = useState<SalesStats>({
    totalGross: 0,
    totalFees: 0,
    totalNet: 0,
    paidCount: 0,
    totalCount: 0,
    withoutDocCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 25;

  // Filters from URL
  const filterParam = searchParams.get('filter') as SalesFilter || 'all';
  const periodParam = searchParams.get('period') || format(new Date(), 'yyyy-MM');
  
  const periodOptions = useMemo(() => generatePeriodOptions(), []);
  
  // Map URL filter params to internal filter
  const activeFilter: SalesFilter = useMemo(() => {
    const param = filterParam as string;
    if (param === 'pendientes') return 'pending';
    if (param === 'sin_documento') return 'without_doc';
    if (param === 'paid' || param === 'pending' || param === 'without_doc' || param === 'cancelled') {
      return param as SalesFilter;
    }
    return 'all';
  }, [filterParam]);

  // Date range from period
  const { startDate, endDate } = useMemo(() => {
    const [year, month] = periodParam.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    return {
      startDate: startOfMonth(date),
      endDate: endOfMonth(date),
    };
  }, [periodParam]);

  // Fetch sales data
  useEffect(() => {
    const fetchSales = async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from('orders')
          .select(`
            id,
            order_id,
            external_sale_id,
            order_date,
            customer_name,
            customer_tax_id,
            gross_amount,
            commission_amount,
            financing_fee,
            net_amount,
            money_release_date,
            status,
            payment_sales!left(sale_id),
            order_tax_documents!left(
              order_id,
              tax_documents(
                document_type,
                document_number,
                client_tax_id
              )
            )
          `)
          .gte('order_date', startDate.toISOString())
          .lte('order_date', endDate.toISOString())
          .order('order_date', { ascending: false });

        if (error) throw error;

        // Transform data
        const transformedSales: SaleRow[] = (data || []).map((order: any) => {
          const taxDoc = order.order_tax_documents?.[0]?.tax_documents;
          return {
            id: order.id,
            orderId: order.order_id,
            externalSaleId: order.external_sale_id,
            orderDate: order.order_date,
            customerName: order.customer_name,
            rut: taxDoc?.client_tax_id || order.customer_tax_id,
            grossAmount: Number(order.gross_amount) || 0,
            fees: (Number(order.commission_amount) || 0) + (Number(order.financing_fee) || 0),
            netAmount: Number(order.net_amount) || 0,
            moneyReleaseDate: order.money_release_date,
            status: order.status,
            hasPayment: order.payment_sales && order.payment_sales.length > 0,
            hasDocument: order.order_tax_documents && order.order_tax_documents.length > 0,
            documentType: taxDoc?.document_type || null,
            documentNumber: taxDoc?.document_number || null,
          };
        });

        setSales(transformedSales);

        // Calculate stats
        const nonCancelled = transformedSales.filter(s => s.status !== 'cancelled');
        setStats({
          totalGross: nonCancelled.reduce((sum, s) => sum + s.grossAmount, 0),
          totalFees: nonCancelled.reduce((sum, s) => sum + s.fees, 0),
          totalNet: nonCancelled.reduce((sum, s) => sum + s.netAmount, 0),
          paidCount: nonCancelled.filter(s => s.hasPayment).length,
          totalCount: nonCancelled.length,
          withoutDocCount: nonCancelled.filter(s => s.hasPayment && !s.hasDocument).length,
        });

      } catch (err) {
        console.error('Error fetching sales:', err);
        setError('No se pudieron cargar las ventas. Intenta recargar la página.');
      } finally {
        setLoading(false);
      }
    };

    fetchSales();
  }, [startDate, endDate]);

  // Filter sales based on active filter
  const filteredSales = useMemo(() => {
    switch (activeFilter) {
      case 'paid':
        return sales.filter(s => s.hasPayment && s.status !== 'cancelled');
      case 'pending':
        return sales.filter(s => !s.hasPayment && s.status !== 'cancelled');
      case 'without_doc':
        return sales.filter(s => s.hasPayment && !s.hasDocument && s.status !== 'cancelled');
      case 'cancelled':
        return sales.filter(s => s.status === 'cancelled');
      default:
        return sales;
    }
  }, [sales, activeFilter]);

  // Pagination
  const totalPages = Math.ceil(filteredSales.length / PAGE_SIZE);
  const paginatedSales = filteredSales.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, periodParam]);

  // Handlers
  const handleFilterChange = (filter: SalesFilter) => {
    const newParams = new URLSearchParams(searchParams);
    if (filter === 'all') {
      newParams.delete('filter');
    } else {
      newParams.set('filter', filter);
    }
    setSearchParams(newParams);
  };

  const handlePeriodChange = (period: string) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set('period', period);
    setSearchParams(newParams);
  };

  const handleRowClick = (saleId: string) => {
    navigate(`/orders/${saleId}`);
  };

  const paidPercentage = stats.totalCount > 0 
    ? ((stats.paidCount / stats.totalCount) * 100).toFixed(1) 
    : '0';

  return (
    <AppLayout>
      <TooltipProvider>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">Ventas</h1>
              <p className="text-muted-foreground">
                Todas las ventas del período con estado de pago y documentación
              </p>
            </div>
          </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <DollarSign className="h-4 w-4" />
                Brutas
              </div>
              {loading ? (
                <Skeleton className="h-7 w-24 mt-1" />
              ) : (
                <p className="text-xl font-bold">{formatCurrency(stats.totalGross)}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <TrendingDown className="h-4 w-4" />
                Fees
              </div>
              {loading ? (
                <Skeleton className="h-7 w-20 mt-1" />
              ) : (
                <p className="text-xl font-bold text-destructive">
                  -{formatCurrency(stats.totalFees)}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <DollarSign className="h-4 w-4" />
                Neto
              </div>
              {loading ? (
                <Skeleton className="h-7 w-24 mt-1" />
              ) : (
                <p className="text-xl font-bold">{formatCurrency(stats.totalNet)}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <CheckCircle className="h-4 w-4" />
                % Pagado
              </div>
              {loading ? (
                <Skeleton className="h-7 w-16 mt-1" />
              ) : (
                <p className="text-xl font-bold">{paidPercentage}%</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <AlertCircle className="h-4 w-4" />
                Sin Doc
              </div>
              {loading ? (
                <Skeleton className="h-7 w-12 mt-1" />
              ) : (
                <p className={`text-xl font-bold ${stats.withoutDocCount > 0 ? 'text-destructive' : ''}`}>
                  {stats.withoutDocCount}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filters Card */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">Estado</label>
                <Select 
                  value={activeFilter} 
                  onValueChange={(value) => handleFilterChange(value as SalesFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Todas" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas ({sales.length})</SelectItem>
                    <SelectItem value="paid">🟢 Pagadas ({sales.filter(s => s.hasPayment && s.status !== 'cancelled').length})</SelectItem>
                    <SelectItem value="pending">🟡 Pendientes ({sales.filter(s => !s.hasPayment && s.status !== 'cancelled').length})</SelectItem>
                    <SelectItem value="without_doc">🔴 Sin Doc ({stats.withoutDocCount})</SelectItem>
                    <SelectItem value="cancelled">↩️ Canceladas ({sales.filter(s => s.status === 'cancelled').length})</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">Período</label>
                <Select value={periodParam} onValueChange={handlePeriodChange}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {periodOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {activeFilter !== 'all' && (
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => handleFilterChange('all')}
                >
                  Limpiar filtros
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Sales Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID Venta</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>RUT</TableHead>
                    <TableHead className="text-right">Bruto</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                    <TableHead>Pagado</TableHead>
                    <TableHead>Liberación</TableHead>
                    <TableHead>Documento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {error ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8 text-destructive">
                        <AlertCircle className="h-5 w-5 inline mr-2" />
                        {error}
                      </TableCell>
                    </TableRow>
                  ) : loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 10 }).map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : paginatedSales.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                        No hay ventas para este período con el filtro seleccionado
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedSales.map((sale) => {
                      const paidStatus = getPaidStatus(sale);
                      const docBadge = getDocumentBadge(sale);
                      return (
                        <TableRow
                          key={sale.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => handleRowClick(sale.id)}
                        >
                          <TableCell className="font-mono text-xs">
                            {sale.orderId || sale.externalSaleId 
                              ? `${(sale.orderId || sale.externalSaleId || '').slice(0, 13)}...` 
                              : sale.id.slice(0, 8)}
                          </TableCell>
                          <TableCell>
                            {format(new Date(sale.orderDate), 'dd/MM/yy')}
                          </TableCell>
                          <TableCell className="max-w-[150px] truncate">
                            {sale.customerName}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {formatRut(sale.rut)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(sale.grossAmount)}
                          </TableCell>
                          <TableCell className="text-right text-destructive">
                            -{formatCurrency(sale.fees)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(sale.netAmount)}
                          </TableCell>
                          <TableCell>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger>
                                  <Badge variant={paidStatus.variant}>
                                    {paidStatus.icon} {paidStatus.label}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {paidStatus.label === 'Pagado' && 'Liquidación recibida'}
                                  {paidStatus.label === 'Retenido' && 'Retenido por marketplace'}
                                  {paidStatus.label === 'Por sincronizar' && 'Fecha de liberación pasada, pendiente sync'}
                                  {paidStatus.label === 'Cancelada' && 'Venta cancelada o devuelta'}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                          <TableCell>
                            {sale.moneyReleaseDate 
                              ? format(new Date(sale.moneyReleaseDate), 'dd/MM/yy')
                              : <span className="text-muted-foreground">Pendiente</span>
                            }
                          </TableCell>
                          <TableCell>
                            <Badge variant={docBadge.variant}>
                              {docBadge.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-muted-foreground">
                  Mostrando {(currentPage - 1) * PAGE_SIZE + 1} - {Math.min(currentPage * PAGE_SIZE, filteredSales.length)} de {filteredSales.length}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    Anterior
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      </TooltipProvider>
    </AppLayout>
  );
};

export default Sales;
