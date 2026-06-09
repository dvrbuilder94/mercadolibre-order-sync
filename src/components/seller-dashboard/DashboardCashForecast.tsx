import { Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface CashForecast {
  next7Days: number;
  next14Days: number;
  next30Days: number;
}

interface DashboardCashForecastProps {
  forecast: CashForecast;
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

export function DashboardCashForecast({ forecast, loading }: DashboardCashForecastProps) {
  const buckets = [
    { label: "Próx. 7 días", value: forecast.next7Days },
    { label: "Próx. 14 días", value: forecast.next14Days },
    { label: "Próx. 30 días", value: forecast.next30Days },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Cash a Liberar</CardTitle>
        </div>
        <CardDescription>
          Estimación basada en fechas de liberación del marketplace
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          {buckets.map((bucket) => (
            <div
              key={bucket.label}
              className="rounded-lg border bg-muted/50 p-4 text-center"
            >
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {bucket.label}
              </p>
              {loading ? (
                <Skeleton className="h-7 w-24 mx-auto" />
              ) : (
                <p className="text-lg font-bold text-foreground">
                  {formatCLP(bucket.value)}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
