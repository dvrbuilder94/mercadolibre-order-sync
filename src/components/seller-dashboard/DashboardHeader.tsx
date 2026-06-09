import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DashboardHeaderProps {
  selectedPeriod: string;
  onPeriodChange: (period: string) => void;
  dataStatus: 'complete' | 'partial' | 'loading';
}

export function DashboardHeader({
  selectedPeriod,
  onPeriodChange,
  dataStatus,
}: DashboardHeaderProps) {
  // Generate last 12 months options
  const periodOptions = Array.from({ length: 12 }, (_, i) => {
    const date = subMonths(new Date(), i);
    return {
      value: format(date, 'yyyy-MM'),
      label: format(date, 'MMMM yyyy', { locale: es }),
    };
  });

  const getStatusBadge = () => {
    switch (dataStatus) {
      case 'complete':
        return (
          <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
            ✓ Conciliado
          </Badge>
        );
      case 'partial':
        return (
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-amber-500/20">
            ⚠ Parcial
          </Badge>
        );
      case 'loading':
        return (
          <Badge variant="outline" className="animate-pulse">
            Cargando...
          </Badge>
        );
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Resumen financiero de tus ventas
        </p>
      </div>

      <div className="flex items-center gap-3">
        {getStatusBadge()}
        
        <Select value={selectedPeriod} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Seleccionar período" />
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
    </div>
  );
}
