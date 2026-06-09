import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { 
  FileText, 
  RefreshCw, 
  Book, 
  TrendingUp, 
  Link2, 
  Download,
  FileSpreadsheet,
  ChevronRight
} from "lucide-react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardExport } from "@/components/seller-dashboard/DashboardExport";

// Generate last 12 months for period selector
const generatePeriodOptions = () => {
  const options = [];
  const today = new Date();
  for (let i = 0; i < 12; i++) {
    const date = subMonths(today, i);
    const value = format(date, "yyyy-MM");
    const label = format(date, "MMMM yyyy", { locale: es });
    options.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return options;
};

interface ReportCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  actionLabel: string;
  onClick: () => void;
  variant?: "default" | "primary";
}

function ReportCard({ title, description, icon, actionLabel, onClick, variant = "default" }: ReportCardProps) {
  const isPrimary = variant === "primary";
  
  return (
    <Card className={isPrimary 
      ? "bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20 hover:border-primary/40 transition-colors" 
      : "hover:border-primary/30 transition-colors"
    }>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isPrimary ? "bg-primary/10" : "bg-muted"}`}>
            {icon}
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="text-sm mt-0.5">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Button 
          variant={isPrimary ? "default" : "outline"} 
          size="sm" 
          onClick={onClick}
          className="w-full justify-between"
        >
          {actionLabel}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

export default function Reports() {
  const navigate = useNavigate();
  const [selectedPeriod, setSelectedPeriod] = useState(format(new Date(), "yyyy-MM"));
  const periodOptions = generatePeriodOptions();

  const reports = [
    {
      title: "Reporte IVA",
      description: "Resumen para declaración F29 SII",
      icon: <FileText className="h-5 w-5 text-primary" />,
      actionLabel: "Generar Reporte",
      onClick: () => navigate(`/reports/iva?period=${selectedPeriod}`),
      variant: "primary" as const,
    },
    {
      title: "Conciliación",
      description: "Ventas vs Pagos recibidos",
      icon: <RefreshCw className="h-5 w-5 text-amber-600" />,
      actionLabel: "Ver Conciliación",
      onClick: () => navigate(`/reports/conciliation?period=${selectedPeriod}`),
    },
    {
      title: "Libro de Ventas",
      description: "Formato SII (Boletas y Facturas)",
      icon: <Book className="h-5 w-5 text-green-600" />,
      actionLabel: "Ver Libro",
      onClick: () => navigate(`/reports/sales-ledger?period=${selectedPeriod}`),
    },
    {
      title: "Análisis de Fees",
      description: "Comisiones y financiamiento ML",
      icon: <TrendingUp className="h-5 w-5 text-blue-600" />,
      actionLabel: "Ver Análisis",
      onClick: () => navigate(`/reports/fees?period=${selectedPeriod}`),
    },
    {
      title: "Cruce Tributario",
      description: "Auditoría Venta ↔ Documento",
      icon: <Link2 className="h-5 w-5 text-violet-600" />,
      actionLabel: "Auditar",
      onClick: () => navigate(`/reports/tax-cross?period=${selectedPeriod}`),
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6 p-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileSpreadsheet className="h-6 w-6" />
              Centro de Reportes
            </h1>
            <p className="text-muted-foreground mt-1">
              Genera informes listos para tu contador y el SII
            </p>
          </div>
          
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="w-[200px]">
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

        {/* Report Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {reports.map((report) => (
            <ReportCard key={report.title} {...report} />
          ))}
        </div>

        {/* Consolidated Report Section */}
        <div className="pt-4">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Download className="h-5 w-5" />
            Reporte Consolidado para Contador
          </h2>
          <DashboardExport period={selectedPeriod} />
        </div>
      </div>
    </AppLayout>
  );
}
