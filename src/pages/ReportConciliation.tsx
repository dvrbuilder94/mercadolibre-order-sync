import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, RefreshCw, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import * as XLSX from "xlsx";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

// Period options
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

interface ConciliationRow {
  periodo: string;
  ventas_brutas: number;
  fees: number;
  neto_esperado: number;
  pagos_recibidos: number;
  diferencia: number;
  cantidad_ventas: number;
  cantidad_pagos: number;
}

export default function ReportConciliation() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodFromUrl = searchParams.get("period");
  const [selectedPeriod, setSelectedPeriod] = useState(periodFromUrl || format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ConciliationRow[]>([]);
  const periodOptions = generatePeriodOptions();

  // Calculate date range from period
  const getDateRange = (period: string) => {
    const [year, month] = period.split("-").map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    return { startDate, endDate };
  };

  // Fetch conciliation data
  const fetchConciliationData = async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getDateRange(selectedPeriod);

      // Fetch orders (ventas)
      const { data: orders, error: ordersError } = await supabase
        .from("orders")
        .select("gross_amount, commission_amount, financing_fee, net_amount")
        .gte("order_date", startDate.toISOString())
        .lte("order_date", endDate.toISOString())
        .neq("status", "cancelled");

      if (ordersError) throw ordersError;

      // Fetch payments
      const { data: payments, error: paymentsError } = await supabase
        .from("payments")
        .select("net_amount")
        .gte("payment_date", startDate.toISOString())
        .lte("payment_date", endDate.toISOString());

      if (paymentsError) throw paymentsError;

      // Calculate totals
      const ventasBrutas = (orders || []).reduce((sum, o) => sum + (Number(o.gross_amount) || 0), 0);
      const fees = (orders || []).reduce(
        (sum, o) => sum + (Number(o.commission_amount) || 0) + (Number(o.financing_fee) || 0),
        0
      );
      const netoEsperado = ventasBrutas - fees;
      const pagosRecibidos = (payments || []).reduce((sum, p) => sum + (Number(p.net_amount) || 0), 0);
      const diferencia = netoEsperado - pagosRecibidos;

      const row: ConciliationRow = {
        periodo: selectedPeriod,
        ventas_brutas: ventasBrutas,
        fees: fees,
        neto_esperado: netoEsperado,
        pagos_recibidos: pagosRecibidos,
        diferencia: diferencia,
        cantidad_ventas: orders?.length || 0,
        cantidad_pagos: payments?.length || 0,
      };

      setData([row]);
    } catch (error: any) {
      console.error("Error fetching conciliation data:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudieron cargar los datos de conciliación",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConciliationData();
    setSearchParams({ period: selectedPeriod });
  }, [selectedPeriod]);

  // Format currency
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("es-CL", {
      style: "currency",
      currency: "CLP",
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Get status badge for difference
  const getStatusBadge = (diferencia: number, netoEsperado: number) => {
    const percentDiff = netoEsperado > 0 ? Math.abs(diferencia / netoEsperado) * 100 : 0;
    
    if (Math.abs(diferencia) < 100) {
      return <Badge className="bg-green-500">✓ Conciliado</Badge>;
    } else if (percentDiff < 1) {
      return <Badge variant="outline" className="border-amber-500 text-amber-600">🟡 Menor diferencia</Badge>;
    } else if (diferencia > 0) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <Badge variant="outline" className="border-amber-500 text-amber-600">🟡 Timing</Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p>Ventas del período que se liquidarán en el siguiente mes</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    } else {
      return <Badge variant="destructive">🔴 Revisar</Badge>;
    }
  };

  // Export to Excel
  const handleExport = () => {
    const [year, month] = selectedPeriod.split("-");
    const monthName = format(new Date(parseInt(year), parseInt(month) - 1), "MMMM", { locale: es });

    const exportData = data.map((row) => ({
      Período: row.periodo,
      "Ventas Brutas": row.ventas_brutas,
      "Fees Marketplace": row.fees,
      "Neto Esperado": row.neto_esperado,
      "Pagos Recibidos": row.pagos_recibidos,
      Diferencia: row.diferencia,
      "Cant. Ventas": row.cantidad_ventas,
      "Cant. Pagos": row.cantidad_pagos,
      Estado: Math.abs(row.diferencia) < 100 ? "Conciliado" : row.diferencia > 0 ? "Timing" : "Revisar",
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    worksheet["!cols"] = [
      { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
      { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Conciliación");
    XLSX.writeFile(workbook, `conciliacion-${monthName}-${year}.xlsx`);

    toast({
      title: "Reporte exportado",
      description: `Conciliación de ${monthName} ${year} descargada`,
    });
  };

  const currentRow = data[0];

  return (
    <AppLayout>
      <div className="space-y-6 p-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/reports")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <RefreshCw className="h-6 w-6" />
                Conciliación de Marketplace
              </h1>
              <p className="text-muted-foreground mt-1">
                Comparación: Ventas devengadas vs Pagos recibidos
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                {periodOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button onClick={handleExport} disabled={loading || data.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Exportar XLSX
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : currentRow ? (
          <>
            {/* Alert for differences */}
            {Math.abs(currentRow.diferencia) >= 100 && (
              <Alert className={currentRow.diferencia > 0 
                ? "border-amber-500/50 bg-amber-500/10" 
                : "border-red-500/50 bg-red-500/10"
              }>
                {currentRow.diferencia > 0 ? (
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-500" />
                )}
                <AlertDescription className={currentRow.diferencia > 0 ? "text-amber-700" : "text-red-700"}>
                  {currentRow.diferencia > 0 
                    ? `Hay ${formatCurrency(currentRow.diferencia)} de ventas pendientes de liquidación. Esto es normal debido al timing de liberación del marketplace.`
                    : `Diferencia negativa de ${formatCurrency(Math.abs(currentRow.diferencia))}. Revisar pagos que corresponden a ventas de períodos anteriores.`
                  }
                </AlertDescription>
              </Alert>
            )}

            {Math.abs(currentRow.diferencia) < 100 && (
              <Alert className="border-green-500/50 bg-green-500/10">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertDescription className="text-green-700">
                  El período está conciliado. Ventas y pagos cuadran correctamente.
                </AlertDescription>
              </Alert>
            )}

            {/* Main Table */}
            <Card>
              <CardHeader>
                <CardTitle>Resumen de Conciliación</CardTitle>
                <CardDescription>
                  Flujo financiero del período: desde ventas brutas hasta pagos recibidos
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Período</TableHead>
                      <TableHead className="text-right">Ventas Brutas</TableHead>
                      <TableHead className="text-right">Fees ML</TableHead>
                      <TableHead className="text-right">Neto Esperado</TableHead>
                      <TableHead className="text-right">Pagos Recibidos</TableHead>
                      <TableHead className="text-right">Diferencia</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">{currentRow.periodo}</TableCell>
                      <TableCell className="text-right">{formatCurrency(currentRow.ventas_brutas)}</TableCell>
                      <TableCell className="text-right text-orange-600">
                        -{formatCurrency(currentRow.fees)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(currentRow.neto_esperado)}
                      </TableCell>
                      <TableCell className="text-right text-green-600">
                        {formatCurrency(currentRow.pagos_recibidos)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(currentRow.diferencia)}
                      </TableCell>
                      <TableCell className="text-center">
                        {getStatusBadge(currentRow.diferencia, currentRow.neto_esperado)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Breakdown Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Ventas Brutas</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(currentRow.ventas_brutas)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {currentRow.cantidad_ventas} ventas confirmadas
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Fees Marketplace</CardDescription>
                  <CardTitle className="text-2xl text-orange-600">
                    -{formatCurrency(currentRow.fees)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    Comisiones + financiamiento
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Pagos Recibidos</CardDescription>
                  <CardTitle className="text-2xl text-green-600">
                    {formatCurrency(currentRow.pagos_recibidos)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {currentRow.cantidad_pagos} liquidaciones
                  </p>
                </CardContent>
              </Card>

              <Card className={Math.abs(currentRow.diferencia) < 100 
                ? "border-green-500/30 bg-green-500/5" 
                : currentRow.diferencia > 0 
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-red-500/30 bg-red-500/5"
              }>
                <CardHeader className="pb-2">
                  <CardDescription>Diferencia</CardDescription>
                  <CardTitle className={`text-2xl ${
                    Math.abs(currentRow.diferencia) < 100 
                      ? "text-green-600" 
                      : currentRow.diferencia > 0 
                        ? "text-amber-600"
                        : "text-red-600"
                  }`}>
                    {formatCurrency(currentRow.diferencia)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {Math.abs(currentRow.diferencia) < 100 
                      ? "Sin diferencias relevantes"
                      : currentRow.diferencia > 0
                        ? "Pendiente de liberación"
                        : "Revisar timing cross-period"
                    }
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Explanation */}
            <Card className="bg-muted/30">
              <CardContent className="pt-6">
                <div className="text-sm text-muted-foreground space-y-2">
                  <p><strong>¿Cómo leer esta conciliación?</strong></p>
                  <ul className="list-disc list-inside space-y-1 ml-2">
                    <li><strong>Ventas Brutas:</strong> Total vendido al cliente en el período</li>
                    <li><strong>Fees:</strong> Comisiones + costos de financiamiento cobrados por MercadoLibre</li>
                    <li><strong>Neto Esperado:</strong> Lo que deberías recibir (Ventas - Fees)</li>
                    <li><strong>Pagos Recibidos:</strong> Liquidaciones efectivamente recibidas en el período</li>
                    <li><strong>Diferencia Positiva:</strong> Normal si hay ventas recientes que se liquidarán el próximo mes</li>
                    <li><strong>Diferencia Negativa:</strong> Puede indicar pagos de meses anteriores recibidos en este período</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No hay datos de conciliación para este período
          </div>
        )}
      </div>
    </AppLayout>
  );
}
