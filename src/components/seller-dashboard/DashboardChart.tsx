import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface DailyData {
  date: string;
  sales: number;
  net: number;
  fees: number;
}

interface DashboardChartProps {
  data: DailyData[];
  loading: boolean;
}

const formatCLP = (value: number) => {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value}`;
};

const formatTooltipValue = (value: number) => {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

export function DashboardChart({ data, loading }: DashboardChartProps) {
  const formattedData = data.map(item => ({
    ...item,
    displayDate: format(new Date(item.date), 'd MMM', { locale: es }),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ventas del Período</CardTitle>
        <CardDescription>
          Ventas brutas, neto y fees por día
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : data.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
            No hay datos para el período seleccionado
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={formattedData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                dataKey="displayDate" 
                className="text-xs"
                tick={{ fill: 'hsl(var(--muted-foreground))' }}
              />
              <YAxis 
                tickFormatter={formatCLP}
                className="text-xs"
                tick={{ fill: 'hsl(var(--muted-foreground))' }}
              />
              <Tooltip 
                formatter={(value: number, name: string) => [
                  formatTooltipValue(value),
                  name === 'sales' ? 'Ventas Brutas' : 
                  name === 'net' ? 'Neto' : 'Fees'
                ]}
                labelFormatter={(label) => `Día: ${label}`}
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                }}
              />
              <Legend 
                formatter={(value) => 
                  value === 'sales' ? 'Ventas Brutas' : 
                  value === 'net' ? 'Neto' : 'Fees'
                }
              />
              <Bar 
                dataKey="sales" 
                fill="hsl(var(--primary))" 
                radius={[4, 4, 0, 0]}
                name="sales"
              />
              <Bar 
                dataKey="net" 
                fill="hsl(142.1 76.2% 36.3%)" 
                radius={[4, 4, 0, 0]}
                name="net"
              />
              <Line 
                type="monotone" 
                dataKey="fees" 
                stroke="hsl(24.6 95% 53.1%)" 
                strokeWidth={2}
                dot={{ fill: 'hsl(24.6 95% 53.1%)', strokeWidth: 0 }}
                name="fees"
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
