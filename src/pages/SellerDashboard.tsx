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
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [sampleResult, setSampleResult] = useState<any>(null);
  const [showSample, setShowSample] = useState(false);

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

  const handleSample = async () => {
    setSampling(true);
    try {
      const { data, error } = await supabase.functions.invoke('data-sample');
      if (error) throw error;
      setSampleResult(data);
      setShowSample(true);
    } catch (error: any) {
      toast.error(error.message || 'Error al obtener muestra');
    } finally {
      setSampling(false);
    }
  };

  const handleDiagnostic = async () => {
    setDiagnosing(true);
    try {
      const { data, error } = await supabase.functions.invoke('pipeline-diagnostic');
      if (error) throw error;
      setDiagnosticResult(data);
      setShowDiagnostic(true);
    } catch (error: any) {
      toast.error(error.message || 'Error al ejecutar diagnóstico');
    } finally {
      setDiagnosing(false);
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

                <Button
                  onClick={handleSample}
                  disabled={sampling}
                  variant="ghost"
                  size="sm"
                  title="Ver muestra de datos reales de ML y Bsale"
                >
                  {sampling ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Info className="h-4 w-4 mr-1" />}
                  Ver Datos
                </Button>

                <Button
                  onClick={handleDiagnostic}
                  disabled={diagnosing}
                  variant="ghost"
                  size="sm"
                  title="Diagnóstico del pipeline de datos"
                >
                  {diagnosing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Info className="h-4 w-4 mr-1" />}
                  Diagnóstico
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

      {/* Dialog de muestra de datos */}
      <Dialog open={showSample} onOpenChange={setShowSample}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Muestra de datos reales</DialogTitle>
            <DialogDescription>Últimos 5 registros de ML y Bsale — campos clave para matching</DialogDescription>
          </DialogHeader>
          {sampleResult && (
            <div className="space-y-6 text-xs font-mono">

              {/* MELI */}
              <div>
                <p className="text-sm font-sans font-semibold mb-2">MercadoLibre — Campos del comprador (buyer)</p>
                <div className="space-y-3">
                  {(sampleResult.meli_orders || []).map((o: any, i: number) => (
                    <div key={i} className="bg-slate-50 rounded p-2 border space-y-0.5">
                      <p><span className="text-muted-foreground">order_id:</span> {o.order_id} | <span className="text-muted-foreground">fecha:</span> {o.order_date} | <span className="text-muted-foreground">monto:</span> ${o.gross_amount?.toLocaleString()}</p>
                      <p><span className="text-muted-foreground">buyer.nickname:</span> {o.buyer_nickname || 'null'} | <span className="text-muted-foreground">email:</span> {o.buyer_email || 'null'}</p>
                      <p><span className="text-muted-foreground">buyer.first_name:</span> {o.buyer_first_name || 'null'} | <span className="text-muted-foreground">last_name:</span> {o.buyer_last_name || 'null'}</p>
                      <p className={o.billing_doc_number ? 'text-green-700 font-bold' : 'text-red-600'}>
                        billing.doc_type: {o.billing_doc_type || 'null'} | billing.doc_number: {o.billing_doc_number || 'null'}
                      </p>
                      <p className="text-muted-foreground">buyer keys: [{(o.buyer_all_keys || []).join(', ')}]</p>
                      <p className="text-muted-foreground">billing keys: [{(o.billing_all_keys || []).join(', ')}]</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* BSALE */}
              <div>
                <p className="text-sm font-sans font-semibold mb-2">Bsale — Campos del cliente y referencias</p>
                <div className="space-y-3">
                  {(sampleResult.bsale_docs || []).map((d: any, i: number) => (
                    <div key={i} className="bg-slate-50 rounded p-2 border space-y-0.5">
                      <p><span className="text-muted-foreground">doc:</span> {d.document_type} #{d.document_number} | <span className="text-muted-foreground">fecha:</span> {d.document_date} | <span className="text-muted-foreground">monto:</span> ${d.total_amount?.toLocaleString()}</p>
                      <p className={d.client_tax_id ? 'text-green-700' : 'text-red-600'}>
                        client_tax_id (RUT guardado): {d.client_tax_id || 'null'} | raw client.code: {d.raw_client_code || 'null'}
                      </p>
                      <p><span className="text-muted-foreground">client_name:</span> {d.client_name} | <span className="text-muted-foreground">company:</span> {d.raw_client_company || 'null'}</p>
                      <p><span className="text-muted-foreground">client.note:</span> {d.raw_client_note || 'null'}</p>
                      <p className={d.external_order_id ? 'text-green-700 font-bold' : 'text-orange-600'}>
                        external_order_id: {d.external_order_id || 'null (no se extrajo número de orden ML)'} | canal: {d.detected_channel || 'null'}
                      </p>
                      <p><span className="text-muted-foreground">payment_method:</span> {d.payment_method_name || 'null'}</p>
                      {d.references?.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">referencias:</span>
                          {d.references.map((r: any, ri: number) => (
                            <p key={ri} className="ml-2">→ reason: "{r.reason}" | number: {r.number} | date: {r.date}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* CROSS CHECK */}
              {sampleResult.cross_check?.length > 0 && (
                <div>
                  <p className="text-sm font-sans font-semibold mb-2">Cross-check: ¿external_order_id de Bsale existe en tabla orders?</p>
                  <div className="space-y-1">
                    {sampleResult.cross_check.map((c: any, i: number) => (
                      <div key={i} className={`p-2 rounded border ${c.order_found_in_db ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        <p>Boleta #{c.bsale_doc} (${c.bsale_amount?.toLocaleString()}) → ext_order_id: {c.external_order_id}</p>
                        <p>{c.order_found_in_db ? '✅ Orden existe en DB' : '❌ Orden NO existe en DB (no sincronizada)'} | montos cuadran: {c.amounts_match ? '✅' : '❌'} (orden: ${c.order_amount?.toLocaleString()})</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowSample(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de diagnóstico del pipeline */}
      <Dialog open={showDiagnostic} onOpenChange={setShowDiagnostic}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Diagnóstico del Pipeline</DialogTitle>
            <DialogDescription>Estado real de órdenes, documentos y vinculaciones</DialogDescription>
          </DialogHeader>
          {diagnosticResult && (
            <div className="space-y-4 text-sm">
              {/* Problems */}
              {diagnosticResult.problems_detected?.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
                  <p className="font-semibold text-red-700 flex items-center gap-1"><AlertTriangle className="h-4 w-4" /> Problemas detectados</p>
                  {diagnosticResult.problems_detected.map((p: string, i: number) => (
                    <p key={i} className="text-red-600">• {p}</p>
                  ))}
                </div>
              )}
              {/* Recommendations */}
              {diagnosticResult.recommendations?.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-1">
                  <p className="font-semibold text-blue-700">Recomendaciones</p>
                  {diagnosticResult.recommendations.map((r: string, i: number) => (
                    <p key={i} className="text-blue-600">→ {r}</p>
                  ))}
                </div>
              )}
              {/* Orders */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/40 rounded-lg p-3">
                  <p className="font-semibold mb-2">Órdenes ML</p>
                  <p>Total: <strong>{diagnosticResult.orders?.total}</strong></p>
                  <p>Con fecha pago: <strong>{diagnosticResult.orders?.with_payment_date}</strong></p>
                  <p>Sin fecha pago: <strong className={diagnosticResult.orders?.without_payment_date > 0 ? "text-orange-600" : ""}>{diagnosticResult.orders?.without_payment_date}</strong></p>
                  <p>Vinculadas a doc: <strong className="text-green-600">{diagnosticResult.orders?.linked_to_doc}</strong></p>
                  <p>Sin documento: <strong className={diagnosticResult.orders?.needing_doc > 0 ? "text-red-600" : "text-green-600"}>{diagnosticResult.orders?.needing_doc}</strong></p>
                </div>
                <div className="bg-muted/40 rounded-lg p-3">
                  <p className="font-semibold mb-2">Documentos Bsale</p>
                  <p>Total emitidos: <strong>{diagnosticResult.tax_documents?.total_issued}</strong></p>
                  <p>Con ID orden: <strong className={diagnosticResult.tax_documents?.with_external_order_id > 0 ? "text-green-600" : "text-red-600"}>{diagnosticResult.tax_documents?.with_external_order_id}</strong></p>
                  <p>Sin ID orden: <strong>{diagnosticResult.tax_documents?.without_external_order_id}</strong></p>
                  <p>Con canal detectado: <strong>{diagnosticResult.tax_documents?.with_detected_channel}</strong></p>
                  <p>Vinculados: <strong className="text-green-600">{diagnosticResult.tax_documents?.linked}</strong></p>
                  <p>Sin vincular: <strong className={diagnosticResult.tax_documents?.unlinked > 0 ? "text-orange-600" : "text-green-600"}>{diagnosticResult.tax_documents?.unlinked}</strong></p>
                </div>
              </div>
              {/* Links */}
              <div className="bg-muted/40 rounded-lg p-3">
                <p className="font-semibold mb-2">Vinculaciones ({diagnosticResult.links?.total} total)</p>
                {diagnosticResult.links?.by_source && Object.entries(diagnosticResult.links.by_source).map(([src, count]: [string, any]) => (
                  <p key={src}>{src}: <strong>{count}</strong></p>
                ))}
              </div>
              {/* Phase 0 */}
              <div className="bg-muted/40 rounded-lg p-3">
                <p className="font-semibold mb-1">Análisis Phase 0 (match por ID de orden)</p>
                <p className={diagnosticResult.phase0_analysis?.docs_matching_an_order > 0 ? "text-orange-600" : "text-green-600"}>
                  {diagnosticResult.phase0_analysis?.note}
                </p>
                {diagnosticResult.phase0_analysis?.sample?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">Muestra (primeros 5 docs sin vincular con external_order_id):</p>
                    {diagnosticResult.phase0_analysis.sample.map((s: any, i: number) => (
                      <p key={i} className="text-xs font-mono">
                        ext_order_id: {s.external_order_id} | orden en DB: {s.order_exists_in_db ? '✅' : '❌'} | canal: {s.detected_channel || 'null'}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowDiagnostic(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default SellerDashboard;
