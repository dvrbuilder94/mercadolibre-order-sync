import { DollarSign, Percent, TrendingUp, Wallet, Clock, HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface DashboardKPIsProps {
  grossSales: number;
  totalFees: number;
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

interface KPICardProps {
  title: string;
  value: number;
  icon: React.ElementType;
  colorClass: string;
  loading: boolean;
  tooltip?: string;
}

function KPICard({ title, value, icon: Icon, colorClass, loading, tooltip }: KPICardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-1">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          {tooltip && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs text-sm">{tooltip}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <Icon className={`h-4 w-4 ${colorClass}`} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className={`text-2xl font-bold ${colorClass}`}>
            {formatCLP(value)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardKPIs({
  grossSales,
  totalFees,
  netEconomic,
  cashAvailable,
  cashRetained,
  loading,
}: DashboardKPIsProps) {
  const kpis = [
    {
      title: "Ventas Brutas",
      value: grossSales,
      icon: DollarSign,
      colorClass: "text-foreground",
      tooltip: "Total vendido al cliente, antes de comisiones.",
    },
    {
      title: "Fees Marketplace",
      value: totalFees,
      icon: Percent,
      colorClass: "text-orange-500",
      tooltip: "Comisiones y costos cobrados por el marketplace.",
    },
    {
      title: "Neto Económico",
      value: netEconomic,
      icon: TrendingUp,
      colorClass: "text-green-600",
      tooltip: "Ingreso real del negocio, antes de pagos. Ventas Brutas menos Fees.",
    },
    {
      title: "Cash Disponible",
      value: cashAvailable,
      icon: Wallet,
      colorClass: "text-green-600",
      tooltip: "Dinero ya liberado y recibido en tu cuenta.",
    },
    {
      title: "Cash Retenido",
      value: cashRetained,
      icon: Clock,
      colorClass: "text-amber-500",
      tooltip: "Ventas cobradas al cliente, pero aún retenidas por el marketplace.",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      {kpis.map((kpi) => (
          <KPICard
            key={kpi.title}
            title={kpi.title}
            value={kpi.value}
            icon={kpi.icon}
            colorClass={kpi.colorClass}
            loading={loading}
            tooltip={kpi.tooltip}
          />
      ))}
    </div>
  );
}
