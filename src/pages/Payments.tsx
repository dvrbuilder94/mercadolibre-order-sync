import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, RefreshCw, Calendar, ArrowUpDown, Store, CreditCard, Building2, Wallet, Landmark } from "lucide-react";
import { format, isAfter, startOfDay } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Channel configuration for multi-channel support
const CHANNEL_CONFIG: Record<string, { icon: typeof Store; label: string }> = {
  'MERCADOPAGO': { icon: Store, label: 'MercadoLibre' },
  'STRIPE': { icon: CreditCard, label: 'Shopify' },
  'SANTANDER': { icon: Building2, label: 'Falabella' },
  'WEBPAY': { icon: Landmark, label: 'WebPay' },
};

const getChannelInfo = (provider: string) => {
  return CHANNEL_CONFIG[provider] || { icon: Wallet, label: provider || 'Otro' };
};

interface PaymentWithStats {
  id: string;
  payment_provider: string;
  external_payment_id: string | null;
  payment_date: string;
  net_amount: number;
  gross_amount: number;
  fees_amount: number;
  sales_count: number;
  sales_without_doc_count: number;
}

export default function Payments() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [payments, setPayments] = useState<PaymentWithStats[]>([]);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<string>("date_desc");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    checkAuth();
    fetchPayments();
  }, []);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      navigate("/auth");
    }
  };

  const fetchPayments = async () => {
    try {
      // Get payments with sales stats
      const { data: paymentsData, error: paymentsError } = await supabase
        .from("payments")
        .select("*")
        .order("payment_date", { ascending: false });

      if (paymentsError) throw paymentsError;

      // Get sales count per payment
      const { data: salesData, error: salesError } = await supabase
        .from("payment_sales")
        .select("payment_id, sale_id");

      if (salesError) throw salesError;

      // Get documented sales (sales with tax documents)
      const { data: docsData, error: docsError } = await supabase
        .from("order_tax_documents")
        .select("order_id");

      if (docsError) throw docsError;

      const documentedSaleIds = new Set(docsData?.map(d => d.order_id) || []);

      // Calculate stats per payment
      const salesByPayment = new Map<string, { total: number; withoutDoc: number }>();
      
      salesData?.forEach(ps => {
        const current = salesByPayment.get(ps.payment_id) || { total: 0, withoutDoc: 0 };
        current.total++;
        if (!documentedSaleIds.has(ps.sale_id)) {
          current.withoutDoc++;
        }
        salesByPayment.set(ps.payment_id, current);
      });

      const paymentsWithStats: PaymentWithStats[] = (paymentsData || []).map(p => {
        const stats = salesByPayment.get(p.id) || { total: 0, withoutDoc: 0 };
        return {
          ...p,
          sales_count: stats.total,
          sales_without_doc_count: stats.withoutDoc,
        };
      });

      setPayments(paymentsWithStats);
    } catch (error) {
      console.error("Error fetching payments:", error);
      toast.error("Error al cargar liquidaciones");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-meli-settlements');
      
      if (error) throw error;
      
      toast.success(`${data.payments || 0} liquidaciones sincronizadas, ${data.payment_sales || 0} ventas vinculadas`);
      await fetchPayments();
    } catch (error: any) {
      console.error('Error syncing payments:', error);
      toast.error('Error al sincronizar liquidaciones');
    } finally {
      setSyncing(false);
    }
  };

  // Simple icon-based conciliation status
  const getConciliacionIcon = (payment: PaymentWithStats) => {
    if (payment.sales_count === 0) {
      return <span className="text-muted-foreground" title="Sin ventas">—</span>;
    }
    if (payment.sales_without_doc_count === 0) {
      return <span title="Conciliada">🟢</span>;
    }
    return (
      <Tooltip>
        <TooltipTrigger>
          <span>🔴</span>
        </TooltipTrigger>
        <TooltipContent>
          {payment.sales_without_doc_count} venta(s) sin documento
        </TooltipContent>
      </Tooltip>
    );
  };

  const isFutureDate = (dateStr: string) => {
    return isAfter(new Date(dateStr), startOfDay(new Date()));
  };

  // Filtered and sorted payments
  const filteredPayments = useMemo(() => {
    let result = [...payments];

    // Channel filter
    if (channelFilter !== "all") {
      result = result.filter(p => p.payment_provider === channelFilter);
    }

    // Status filter
    if (statusFilter === "complete") {
      result = result.filter(p => p.sales_count > 0 && p.sales_without_doc_count === 0);
    } else if (statusFilter === "incomplete") {
      result = result.filter(p => p.sales_without_doc_count > 0);
    }

    // Date filters
    if (dateFrom) {
      result = result.filter(p => p.payment_date >= dateFrom);
    }
    if (dateTo) {
      result = result.filter(p => p.payment_date <= dateTo + "T23:59:59");
    }

    // Sorting
    result.sort((a, b) => {
      switch (sortBy) {
        case "date_asc":
          return new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime();
        case "date_desc":
          return new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime();
        case "amount_asc":
          return a.net_amount - b.net_amount;
        case "amount_desc":
          return b.net_amount - a.net_amount;
        default:
          return 0;
      }
    });

    return result;
  }, [payments, dateFrom, dateTo, sortBy, channelFilter, statusFilter]);

  // Stats
  const stats = useMemo(() => {
    const totalReceived = payments.reduce((sum, p) => sum + p.net_amount, 0);
    const totalFees = payments.reduce((sum, p) => sum + p.fees_amount, 0);
    const incompletePayments = payments.filter(p => p.sales_without_doc_count > 0).length;
    const totalSalesWithoutDoc = payments.reduce((sum, p) => sum + p.sales_without_doc_count, 0);
    return { totalReceived, totalFees, incompletePayments, totalSalesWithoutDoc };
  }, [payments]);

  // Get unique channels for filter
  const availableChannels = useMemo(() => {
    const channels = new Set(payments.map(p => p.payment_provider).filter(Boolean));
    return Array.from(channels);
  }, [payments]);

  const hasActiveFilters = dateFrom || dateTo || channelFilter !== "all" || statusFilter !== "all";

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <TooltipProvider>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">Liquidaciones</h1>
              <p className="text-muted-foreground">
                Pagos recibidos desde tus canales de venta
              </p>
            </div>
            <Button onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Sincronizar
            </Button>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Recibido (Neto)</CardDescription>
                <CardTitle className="text-2xl text-green-600">
                  ${stats.totalReceived.toLocaleString("es-CL")}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Fees</CardDescription>
                <CardTitle className="text-2xl text-orange-600">
                  -${stats.totalFees.toLocaleString("es-CL")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Comisiones cobradas
                </p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Incompletas</CardDescription>
                <CardTitle className={`text-2xl ${stats.incompletePayments > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                  {stats.incompletePayments}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Liquidaciones sin documentar
                </p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Ventas Sin Documento</CardDescription>
                <CardTitle className={`text-2xl ${stats.totalSalesWithoutDoc > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
                  {stats.totalSalesWithoutDoc}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Pagadas sin boleta/factura
                </p>
              </CardHeader>
            </Card>
          </div>

          {/* Filters */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Desde</Label>
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="w-[140px]"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Hasta</Label>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="w-[140px]"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Canal</Label>
                  <Select value={channelFilter} onValueChange={setChannelFilter}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      {availableChannels.map(channel => {
                        const info = getChannelInfo(channel);
                        return (
                          <SelectItem key={channel} value={channel}>
                            {info.label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Estado</Label>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="complete">Conciliadas</SelectItem>
                      <SelectItem value="incomplete">Incompletas</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Ordenar</Label>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-[160px]">
                      <ArrowUpDown className="h-4 w-4 mr-2" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date_desc">Más reciente</SelectItem>
                      <SelectItem value="date_asc">Más antigua</SelectItem>
                      <SelectItem value="amount_desc">Mayor monto</SelectItem>
                      <SelectItem value="amount_asc">Menor monto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {hasActiveFilters && (
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => { 
                      setDateFrom(""); 
                      setDateTo(""); 
                      setChannelFilter("all"); 
                      setStatusFilter("all"); 
                    }}
                  >
                    Limpiar filtros
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Payments Table */}
          <Card>
            <CardHeader>
              <CardTitle>Lista de Liquidaciones</CardTitle>
              <CardDescription>
                Cada liquidación agrupa múltiples ventas. Haz clic en una fila para ver el detalle.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <Tooltip>
                          <TooltipTrigger className="flex items-center gap-1 cursor-help">
                            <Calendar className="h-4 w-4" />
                            Fecha de Pago
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[250px]">
                            Fecha en que el canal libera el dinero. 
                            Puede ser estimada y distinta a la fecha de venta.
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-center">Ventas</TableHead>
                      <TableHead className="text-right">Fees</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayments.map((payment) => {
                      const channelInfo = getChannelInfo(payment.payment_provider);
                      const ChannelIcon = channelInfo.icon;
                      return (
                        <TableRow 
                          key={payment.id} 
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => navigate(`/payments/${payment.id}`)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {format(new Date(payment.payment_date), "dd/MM/yyyy", { locale: es })}
                              {isFutureDate(payment.payment_date) && (
                                <span className="text-amber-600 text-xs" title="Fecha estimada">🟡</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <ChannelIcon className="h-4 w-4" />
                              <span className="text-sm">{payment.payment_provider || 'N/A'}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            ${payment.net_amount.toLocaleString("es-CL")}
                          </TableCell>
                          <TableCell className="text-center text-muted-foreground">
                            {payment.sales_count}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            -${payment.fees_amount.toLocaleString("es-CL")}
                          </TableCell>
                          <TableCell className="text-center">
                            {getConciliacionIcon(payment)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredPayments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No hay liquidaciones. Sincroniza desde tu canal de venta.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </TooltipProvider>
    </AppLayout>
  );
}