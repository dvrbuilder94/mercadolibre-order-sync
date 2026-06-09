import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { TrendingUp, Download, Loader2 } from "lucide-react";
import * as XLSX from "xlsx";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface FeesByMethod {
  payment_method_type: string;
  cantidad: number;
  comisiones: number;
  financiamiento: number;
  total_fees: number;
  fee_promedio_pct: number;
  gross_amount: number;
}

interface FeeSummary {
  totalCommissions: number;
  totalFinancing: number;
  totalFees: number;
  avgFeePct: number;
  totalGross: number;
}

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

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value);
};

const getPaymentMethodLabel = (method: string | null): string => {
  const labels: Record<string, string> = {
    credit_card: "Tarjeta de Crédito",
    debit_card: "Tarjeta de Débito",
    account_money: "Dinero en Cuenta",
    consumer_credits: "Crédito de Consumo",
    bank_transfer: "Transferencia",
    prepaid_card: "Tarjeta Prepago",
    ticket: "Efectivo",
  };
  return labels[method || ""] || method || "Sin especificar";
};

export default function ReportFees() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periodParam = searchParams.get("period");
  const [selectedPeriod, setSelectedPeriod] = useState(
    periodParam || format(new Date(), "yyyy-MM")
  );
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [feesByMethod, setFeesByMethod] = useState<FeesByMethod[]>([]);
  const [summary, setSummary] = useState<FeeSummary>({
    totalCommissions: 0,
    totalFinancing: 0,
    totalFees: 0,
    avgFeePct: 0,
    totalGross: 0,
  });

  const periodOptions = generatePeriodOptions();

  const fetchFeesData = useCallback(async (period: string) => {
    setLoading(true);
    try {
      const [year, month] = period.split("-").map(Number);
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      const { data: orders, error } = await supabase
        .from("orders")
        .select("payment_method_type, gross_amount, commission_amount, financing_fee")
        .gte("order_date", startDate.toISOString())
        .lte("order_date", endDate.toISOString())
        .neq("status", "cancelled");

      if (error) throw error;

      // Aggregate by payment method
      const aggregated = (orders || []).reduce((acc, order) => {
        const method = order.payment_method_type || "unknown";
        if (!acc[method]) {
          acc[method] = {
            payment_method_type: method,
            cantidad: 0,
            comisiones: 0,
            financiamiento: 0,
            total_fees: 0,
            fee_promedio_pct: 0,
            gross_amount: 0,
          };
        }
        acc[method].cantidad += 1;
        acc[method].comisiones += Number(order.commission_amount) || 0;
        acc[method].financiamiento += Number(order.financing_fee) || 0;
        acc[method].gross_amount += Number(order.gross_amount) || 0;
        return acc;
      }, {} as Record<string, FeesByMethod>);

      // Calculate totals and percentages
      const methodsArray = Object.values(aggregated).map((m) => ({
        ...m,
        total_fees: m.comisiones + m.financiamiento,
        fee_promedio_pct: m.gross_amount > 0 
          ? ((m.comisiones + m.financiamiento) / m.gross_amount) * 100 
          : 0,
      }));

      // Sort by total fees descending
      methodsArray.sort((a, b) => b.total_fees - a.total_fees);

      setFeesByMethod(methodsArray);

      // Calculate summary
      const totalCommissions = methodsArray.reduce((sum, m) => sum + m.comisiones, 0);
      const totalFinancing = methodsArray.reduce((sum, m) => sum + m.financiamiento, 0);
      const totalFees = totalCommissions + totalFinancing;
      const totalGross = methodsArray.reduce((sum, m) => sum + m.gross_amount, 0);
      const avgFeePct = totalGross > 0 ? (totalFees / totalGross) * 100 : 0;

      setSummary({
        totalCommissions,
        totalFinancing,
        totalFees,
        avgFeePct,
        totalGross,
      });
    } catch (error) {
      console.error("Error fetching fees data:", error);
      toast({
        title: "Error",
        description: "No se pudieron cargar los datos de fees",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeesData(selectedPeriod);
  }, [selectedPeriod, fetchFeesData]);

  const handlePeriodChange = (value: string) => {
    setSelectedPeriod(value);
    setSearchParams({ period: value });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const workbook = XLSX.utils.book_new();

      // Summary sheet
      const summaryData = [
        { Concepto: "Total Comisiones", Valor: summary.totalCommissions },
        { Concepto: "Total Financiamiento", Valor: summary.totalFinancing },
        { Concepto: "Total Fees", Valor: summary.totalFees },
        { Concepto: "Fee Promedio %", Valor: `${summary.avgFeePct.toFixed(2)}%` },
        { Concepto: "Ventas Brutas", Valor: summary.totalGross },
      ];
      const summarySheet = XLSX.utils.json_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");

      // Detail sheet
      const detailData = feesByMethod.map((m) => ({
        "Método de Pago": getPaymentMethodLabel(m.payment_method_type),
        "Cantidad Ventas": m.cantidad,
        "Ventas Brutas": m.gross_amount,
        Comisiones: m.comisiones,
        Financiamiento: m.financiamiento,
        "Total Fees": m.total_fees,
        "Fee %": `${m.fee_promedio_pct.toFixed(2)}%`,
      }));
      const detailSheet = XLSX.utils.json_to_sheet(detailData);
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Desglose");

      const [year, month] = selectedPeriod.split("-");
      const fileName = `fees-analysis-${year}-${month}.xlsx`;
      XLSX.writeFile(workbook, fileName);

      toast({
        title: "Exportación completada",
        description: `Archivo ${fileName} descargado`,
      });
    } catch (error) {
      console.error("Error exporting:", error);
      toast({
        title: "Error",
        description: "No se pudo exportar el reporte",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 p-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <TrendingUp className="h-6 w-6" />
              Análisis de Fees
            </h1>
            <p className="text-muted-foreground mt-1">
              Comisiones y costos del marketplace
            </p>
          </div>

          <div className="flex gap-2">
            <Select value={selectedPeriod} onValueChange={handlePeriodChange}>
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

            <Button
              variant="outline"
              onClick={handleExport}
              disabled={exporting || loading}
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Exportar
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Comisiones
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <p className="text-2xl font-bold">
                  {formatCurrency(summary.totalCommissions)}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Financiamiento
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <p className="text-2xl font-bold">
                  {formatCurrency(summary.totalFinancing)}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Fee Promedio
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-2xl font-bold">
                  {summary.avgFeePct.toFixed(2)}%
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Fees
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <p className="text-2xl font-bold text-destructive">
                  {formatCurrency(summary.totalFees)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Table */}
        <Card>
          <CardHeader>
            <CardTitle>Desglose por Método de Pago</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : feesByMethod.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">
                No hay datos de fees para este período
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Método de Pago</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Ventas Brutas</TableHead>
                    <TableHead className="text-right">Comisiones</TableHead>
                    <TableHead className="text-right">Financ.</TableHead>
                    <TableHead className="text-right">Total Fees</TableHead>
                    <TableHead className="text-right">% Prom</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feesByMethod.map((method) => (
                    <TableRow key={method.payment_method_type}>
                      <TableCell className="font-medium">
                        {getPaymentMethodLabel(method.payment_method_type)}
                      </TableCell>
                      <TableCell className="text-right">{method.cantidad}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(method.gross_amount)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(method.comisiones)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(method.financiamiento)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(method.total_fees)}
                      </TableCell>
                      <TableCell className="text-right">
                        {method.fee_promedio_pct.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))}
                  {/* Totals row */}
                  <TableRow className="bg-muted/50 font-bold">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right">
                      {feesByMethod.reduce((sum, m) => sum + m.cantidad, 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(summary.totalGross)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(summary.totalCommissions)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(summary.totalFinancing)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(summary.totalFees)}
                    </TableCell>
                    <TableCell className="text-right">
                      {summary.avgFeePct.toFixed(2)}%
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
