import { useState, useEffect, useCallback } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { es } from "date-fns/locale";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { DashboardHeader } from "@/components/seller-dashboard/DashboardHeader";
import { DashboardKPIs } from "@/components/seller-dashboard/DashboardKPIs";
import { DashboardAccountingAlerts } from "@/components/seller-dashboard/DashboardAccountingAlerts";
import { DashboardCoherence } from "@/components/seller-dashboard/DashboardCoherence";
import { DashboardExport } from "@/components/seller-dashboard/DashboardExport";
import { ClosingStatusBanner } from "@/components/ClosingStatusBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RefreshCw, Loader2, Lock, Info, GitMerge, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DashboardStats {
  grossSales: number;
  totalFees: number;
  netEconomic: number;
  cashAvailable: number;
  cashRetained: number;
}

interface AccountingAlerts {
  paidWithoutDoc: number;
  refundsWithoutNC: number;
}

interface ClosingStatus {
  status: 'green' | 'yellow' | 'red';
  message: string;
  canClose: boolean;
  blockingCount?: number;
}

interface ClosingRecord {
  id: string;
  status: string;
  closed_at: string | null;
  observations: string | null;
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(amount);
};

const SellerDashboard = () => {
  const [selectedPeriod, setSelectedPeriod] = useState(() => format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState<DashboardStats>({
    grossSales: 0,
    totalFees: 0,
    netEconomic: 0,
    cashAvailable: 0,
    cashRetained: 0,
  });
  const [accountingAlerts, setAccountingAlerts] = useState<AccountingAlerts>({
    paidWithoutDoc: 0,
    refundsWithoutNC: 0,
  });
  const [closingRecord, setClosingRecord] = useState<ClosingRecord | null>(null);
  const [retainedSalesCount, setRetainedSalesCount] = useState(0);
  const [showObservationsDialog, setShowObservationsDialog] = useState(false);
  const [observations, setObservations] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<any>(null);
  const [showReconcileResult, setShowReconcileResult] = useState(false);
  const [dataStatus, setDataStatus] = useState<'complete' | 'partial' | 'loading'>('loading');

  const fetchDashboardStats = useCallback(async (period: string): Promise<DashboardStats> => {
    const [year, month] = period.split("-").map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const { data: orders } = await supabase
      .from('orders')
      .select('id, gross_amount, net_amount, commission_amount, financing_fee, order_date, status')
      .gte('order_date', startDate.toISOString())
      .lte('order_date', endDate.toISOString())
      .neq('status', 'cancelled');

    const { data: payments } = await supabase
      .from('payments')
      .select('id, net_amount, payment_date')
      .gte('payment_date', startDate.toISOString())
      .lte('payment_date', endDate.toISOString());

    const { data: paymentSales } = await supabase
      .from('payment_sales')
      .select('sale_id');

    const paidSaleIds = new Set(paymentSales?.map(ps => ps.sale_id) || []);
    const confirmedOrders = orders || [];

    const grossSales = confirmedOrders.reduce(
      (sum, o) => sum + (Number(o.gross_amount) || 0), 0
    );

    const totalFees = confirmedOrders.reduce(
      (sum, o) => sum + (Number(o.commission_amount) || 0) + (Number(o.financing_fee) || 0), 0
    );

    const netEconomic = grossSales - totalFees;

    const cashAvailable = (payments || []).reduce(
      (sum, p) => sum + (Number(p.net_amount) || 0), 0
    );

    const retainedOrders = confirmedOrders.filter(o => !paidSaleIds.has(o.id));
    const cashRetained = retainedOrders.reduce(
      (sum, o) => sum + (Number(o.net_amount) || 0), 0
    );

    setRetainedSalesCount(retainedOrders.length);

    return {
      grossSales,
      totalFees,
      netEconomic,
      cashAvailable,
      cashRetained,
    };
  }, []);

  const fetchAccountingAlerts = useCallback(async (): Promise<AccountingAlerts> => {
    const { data: ledgerData } = await supabase
      .from('v_ledger')
      .select('estado_contable')
      .eq('type', 'SALE')
      .in('estado_contable', ['PAGADA_SIN_DOCUMENTO', 'DEVUELTA_SIN_NC']);

    const alerts = (ledgerData || []).reduce(
      (acc, row) => {
        if (row.estado_contable === 'PAGADA_SIN_DOCUMENTO') {
          acc.paidWithoutDoc++;
        } else if (row.estado_contable === 'DEVUELTA_SIN_NC') {
          acc.refundsWithoutNC++;
        }
        return acc;
      },
      { paidWithoutDoc: 0, refundsWithoutNC: 0 }
    );

    return alerts;
  }, []);

  const fetchClosingRecord = useCallback(async (period: string) => {
    const { data } = await supabase
      .from("monthly_closings")
      .select("*")
      .eq("period", period)
      .maybeSingle();
    
    setClosingRecord(data);
  }, []);

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    setDataStatus('loading');

    try {
      const [currentStats, alertsData] = await Promise.all([
        fetchDashboardStats(selectedPeriod),
        fetchAccountingAlerts(),
        fetchClosingRecord(selectedPeriod),
      ]);

      setStats(currentStats);
      setAccountingAlerts(alertsData);

      if (currentStats.cashRetained > 0) {
        setDataStatus('partial');
      } else {
        setDataStatus('complete');
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod, fetchDashboardStats, fetchAccountingAlerts, fetchClosingRecord]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  const getClosingStatus = (): ClosingStatus => {
    if (closingRecord?.status === 'closed' || closingRecord?.status === 'closed_with_observations') {
      return { status: 'green', message: 'Período cerrado', canClose: false };
    }

    const totalBlocking = accountingAlerts.paidWithoutDoc + accountingAlerts.refundsWithoutNC;

    if (totalBlocking > 0) {
      return {
        status: 'red',
        message: `${totalBlocking} venta${totalBlocking !== 1 ? 's' : ''} pagada${totalBlocking !== 1 ? 's' : ''} sin documento tributario`,
        canClose: false,
        blockingCount: totalBlocking
      };
    }

    if (retainedSalesCount > 0) {
      return {
        status: 'yellow',
        message: `${retainedSalesCount} venta${retainedSalesCount !== 1 ? 's' : ''} retenida${retainedSalesCount !== 1 ? 's' : ''} por el marketplace`,
        canClose: true
      };
    }

    return { status: 'green', message: 'Todas las ventas documentadas — Listo para cerrar', canClose: true };
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-meli-settlements');
      if (error) throw error;
      toast.success(`Sincronización completada: ${data?.payments || 0} liquidaciones procesadas`);
      fetchAllData();
    } catch (error: any) {
      console.error('Error syncing:', error);
      toast.error(error.message || 'Error al sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  const handleAutoReconcile = async () => {
    setReconciling(true);
    try {
      const { data, error } = await supabase.functions.invoke('auto-reconcile');
      if (error) throw error;
      setReconcileResult(data);
      setShowReconcileResult(true);
      fetchAllData();
    } catch (error: any) {
      toast.error(error.message || 'Error al conciliar automáticamente');
    } finally {
      setReconciling(false);
    }
  };

  const handleClose = async (withObservations: boolean) => {
    if (withObservations && !observations.trim()) {
      toast.error("Ingresa las observaciones");
      return;
    }

    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const closingData = {
        user_id: user.id,
        period: selectedPeriod,
        status: withObservations ? 'closed_with_observations' : 'closed',
        observations: withObservations ? observations : null,
        closed_at: new Date().toISOString(),
        closed_by: user.id,
        total_sales_count: 0,
        total_sales_amount: stats.grossSales,
        total_payments_count: 0,
        total_payments_amount: stats.cashAvailable,
      };

      if (closingRecord) {
        await supabase
          .from("monthly_closings")
          .update(closingData)
          .eq("id", closingRecord.id);
      } else {
        await supabase
          .from("monthly_closings")
          .insert(closingData);
      }

      toast.success("Período cerrado correctamente");
      setShowObservationsDialog(false);
      setObservations("");
      fetchAllData();
    } catch (error) {
      console.error("Error closing period:", error);
      toast.error("Error al cerrar el período");
    } finally {
      setSaving(false);
    }
  };

  const handleReopenPeriod = async () => {
    setSaving(true);
    try {
      await supabase
        .from("monthly_closings")
        .update({ status: 'open', closed_at: null, closed_by: null })
        .eq("id", closingRecord!.id);

      toast.success("Período reabierto");
      fetchAllData();
    } catch (error) {
      console.error("Error reopening period:", error);
      toast.error("Error al reabrir el período");
    } finally {
      setSaving(false);
    }
  };

  const closingStatus = getClosingStatus();
  const isClosed = closingRecord?.status === 'closed' || closingRecord?.status === 'closed_with_observations';
  const difference = stats.grossSales - stats.totalFees - stats.cashAvailable;

  return (
    <AppLayout>
      <TooltipProvider>
        <div className="container px-4 md:px-6 py-8 space-y-6">
          <DashboardHeader
            selectedPeriod={selectedPeriod}
            onPeriodChange={setSelectedPeriod}
            dataStatus={dataStatus}
          />

          {/* Estado del Cierre */}
          <ClosingStatusBanner 
            status={closingStatus.status} 
            message={closingStatus.message}
            isClosed={isClosed}
            closedAt={closingRecord?.closed_at || undefined}
            observations={closingRecord?.observations || undefined}
            blockingCount={closingStatus.blockingCount}
            selectedPeriod={selectedPeriod}
          />

          <DashboardKPIs
            grossSales={stats.grossSales}
            totalFees={stats.totalFees}
            netEconomic={stats.netEconomic}
            cashAvailable={stats.cashAvailable}
            cashRetained={stats.cashRetained}
            loading={loading}
          />

          <DashboardAccountingAlerts
            alerts={accountingAlerts}
            loading={loading}
            onReconcile={handleAutoReconcile}
            reconciling={reconciling}
          />

          {/* Resumen Financiero */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Resumen Financiero</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-muted-foreground">Ventas confirmadas</span>
                    <span className="font-semibold text-lg">{formatCurrency(stats.grossSales)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Comisiones y fees</span>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-4 w-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>Las comisiones pueden diferir de las liquidadas por timing entre períodos.</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="font-semibold text-lg text-orange-600">-{formatCurrency(stats.totalFees)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Pagos recibidos netos</span>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-4 w-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>Pagos pueden liquidarse en un mes distinto al de la venta.</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="font-semibold text-lg text-green-600">{formatCurrency(stats.cashAvailable)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Diferencia pendiente</span>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-4 w-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>Diferencia por timing del marketplace o fees no liquidados.</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <span className={`font-semibold text-lg ${Math.abs(difference) > 100 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                      {formatCurrency(difference)}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <DashboardCoherence
            netEconomic={stats.netEconomic}
            cashAvailable={stats.cashAvailable}
            cashRetained={stats.cashRetained}
            loading={loading}
          />

          {/* Acciones */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={handleSync}
                  disabled={syncing || reconciling}
                  variant="outline"
                >
                  {syncing ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Sincronizar Datos
                </Button>

                <Button
                  onClick={handleAutoReconcile}
                  disabled={reconciling || syncing}
                  variant="outline"
                >
                  {reconciling ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <GitMerge className="h-4 w-4 mr-2" />
                  )}
                  {reconciling ? 'Conciliando...' : 'Conciliar Automáticamente'}
                </Button>

                {isClosed ? (
                  <Button 
                    onClick={handleReopenPeriod} 
                    disabled={saving}
                    variant="outline"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
                    Reabrir Período
                  </Button>
                ) : closingStatus.canClose ? (
                  closingStatus.status === 'yellow' ? (
                    <Button 
                      onClick={() => setShowObservationsDialog(true)} 
                      disabled={saving}
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Cerrar con Observaciones
                    </Button>
                  ) : (
                    <Button 
                      onClick={() => handleClose(false)} 
                      disabled={saving}
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Cerrar Período
                    </Button>
                  )
                ) : (
                  <Button disabled variant="outline">
                    Resuelve los bloqueos para cerrar
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <DashboardExport period={selectedPeriod} />
        </div>
      </TooltipProvider>

      {/* Dialog de observaciones */}
      <Dialog open={showObservationsDialog} onOpenChange={setShowObservationsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cerrar con Observaciones</DialogTitle>
            <DialogDescription>
              Ingresa las observaciones para el cierre del período. Esto quedará registrado en el historial.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Ej: Ventas retenidas pendientes de liberación por el marketplace..."
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowObservationsDialog(false)}>
              Cancelar
            </Button>
            <Button onClick={() => handleClose(true)} disabled={saving || !observations.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirmar Cierre
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de resultados de auto-reconcile */}
      <Dialog open={showReconcileResult} onOpenChange={setShowReconcileResult}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              Conciliación Completada
            </DialogTitle>
            <DialogDescription>
              Resultados del proceso automático de 4 etapas
            </DialogDescription>
          </DialogHeader>
          {reconcileResult && (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Banco ↔ Liquidaciones</span>
                <span className="font-semibold">{reconcileResult.stage1_bank_settlement ?? 0} vinculados</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Liquidación ↔ Orden</span>
                <span className="font-semibold">{reconcileResult.stage2_settlement_order ?? 0} vinculados</span>
              </div>
              <div className="py-2 border-b space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Orden ↔ Documento tributario</span>
                  <span className="font-semibold text-green-600">
                    {(reconcileResult.stage3_order_taxdoc?.hard_linked ?? 0) +
                     (reconcileResult.stage3_order_taxdoc?.auto_linked ?? 0) +
                     (reconcileResult.stage3_order_taxdoc?.auto_soft ?? 0) +
                     (reconcileResult.stage3_order_taxdoc?.auto_consolidated ?? 0)} vinculados
                  </span>
                </div>
                {reconcileResult.stage3_order_taxdoc?.ambiguous > 0 && (
                  <div className="flex items-center gap-1 text-amber-600">
                    <AlertTriangle className="h-3 w-3" />
                    <span>{reconcileResult.stage3_order_taxdoc.ambiguous} casos ambiguos requieren revisión manual</span>
                  </div>
                )}
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Devoluciones sin NC</span>
                <span className="font-semibold">{reconcileResult.stage4_refunds_flagged ?? 0} marcadas</span>
              </div>
              <div className="flex justify-between pt-1 font-semibold">
                <span>Total procesado</span>
                <span className="text-primary">{reconcileResult.total ?? 0} registros</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowReconcileResult(false)}>Entendido</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default SellerDashboard;
