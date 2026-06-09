import { AlertTriangle, FileX, ReceiptText } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

interface AccountingAlerts {
  paidWithoutDoc: number;
  refundsWithoutNC: number;
}

interface DashboardAccountingAlertsProps {
  alerts: AccountingAlerts;
  loading: boolean;
}

export function DashboardAccountingAlerts({ alerts, loading }: DashboardAccountingAlertsProps) {
  const navigate = useNavigate();

  if (loading) return null;

  const hasAlerts = alerts.paidWithoutDoc > 0 || alerts.refundsWithoutNC > 0;

  if (!hasAlerts) return null;

  return (
    <div className="space-y-3">
      {alerts.paidWithoutDoc > 0 && (
        <Alert className="border-red-500/50 bg-red-500/10">
          <FileX className="h-4 w-4 text-red-500" />
          <AlertDescription className="flex items-center justify-between w-full">
            <span className="text-red-700">
              {alerts.paidWithoutDoc} {alerts.paidWithoutDoc === 1 ? 'venta pagada' : 'ventas pagadas'} sin documento tributario {alerts.paidWithoutDoc === 1 ? 'bloquea' : 'bloquean'} el cierre del mes
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-700 hover:text-red-800 hover:bg-red-500/20"
              onClick={() => navigate('/sales/issues?filter=PAGADA_SIN_DOCUMENTO')}
            >
              Ver ventas →
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {alerts.refundsWithoutNC > 0 && (
        <Alert className="border-red-500/50 bg-red-500/10">
          <ReceiptText className="h-4 w-4 text-red-500" />
          <AlertDescription className="flex items-center justify-between w-full">
            <span className="text-red-700">
              {alerts.refundsWithoutNC} {alerts.refundsWithoutNC === 1 ? 'devolución' : 'devoluciones'} sin Nota de Crédito {alerts.refundsWithoutNC === 1 ? 'bloquea' : 'bloquean'} el cierre
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-700 hover:text-red-800 hover:bg-red-500/20"
              onClick={() => navigate('/sales/issues?filter=DEVUELTA_SIN_NC')}
            >
              Ver ventas →
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
