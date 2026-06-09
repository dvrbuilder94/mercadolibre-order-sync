import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface DashboardCoherenceProps {
  netEconomic: number;
  cashAvailable: number;
  cashRetained: number;
  loading: boolean;
}

const formatCLP = (amount: number) => {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

export function DashboardCoherence({
  netEconomic,
  cashAvailable,
  cashRetained,
  loading,
}: DashboardCoherenceProps) {
  if (loading) return null;

  const sum = cashAvailable + cashRetained;
  const difference = Math.abs(netEconomic - sum);
  const percentDiff = netEconomic > 0 ? (difference / netEconomic) * 100 : 0;
  const isCoherent = difference < 100; // Tolerancia de $100 CLP para redondeos

  if (isCoherent) {
    return (
      <Card className="border-green-500/30 bg-green-500/5">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-green-700">Coherencia Financiera:</span>
              <span className="text-muted-foreground">
                Neto Económico ({formatCLP(netEconomic)}) = Cash Disponible ({formatCLP(cashAvailable)}) + Cash Retenido ({formatCLP(cashRetained)})
              </span>
              <span className="text-green-600 font-medium">✓ Cuadra</span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="py-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-amber-700">Revisar Conciliación</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Diferencia: {formatCLP(difference)} ({percentDiff.toFixed(2)}%)
            </p>
            <p className="text-xs text-muted-foreground">
              Posibles causas: redondeos, fees pendientes de sincronización, o pagos parciales.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
