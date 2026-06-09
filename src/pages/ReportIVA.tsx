import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, FileText, Loader2 } from "lucide-react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import * as XLSX from "xlsx";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

// Document type labels
const documentTypeLabels: Record<string, { label: string; code: number }> = {
  boleta: { label: "Boleta Electrónica", code: 39 },
  factura: { label: "Factura Electrónica", code: 33 },
  factura_exenta: { label: "Factura Exenta", code: 34 },
  nota_credito: { label: "Nota de Crédito", code: 61 },
  nota_debito: { label: "Nota de Débito", code: 56 },
};

interface IVARow {
  document_type: string;
  cantidad: number;
  base_imponible: number;
  iva: number;
  total: number;
}

export default function ReportIVA() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodFromUrl = searchParams.get("period");
  const [selectedPeriod, setSelectedPeriod] = useState(periodFromUrl || format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<IVARow[]>([]);
  const periodOptions = generatePeriodOptions();

  // Calculate date range from period
  const getDateRange = (period: string) => {
    const [year, month] = period.split("-").map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    return { 
      startDate: format(startDate, "yyyy-MM-dd"), 
      endDate: format(endDate, "yyyy-MM-dd") 
    };
  };

  // Fetch IVA data
  const fetchIVAData = async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getDateRange(selectedPeriod);
      
      const { data: taxDocs, error } = await supabase
        .from("tax_documents")
        .select("document_type, net_amount, tax_amount, total_amount")
        .gte("document_date", startDate)
        .lte("document_date", endDate)
        .eq("status", "issued");

      if (error) throw error;

      // Aggregate by document type
      const aggregated = (taxDocs || []).reduce((acc, doc) => {
        const type = doc.document_type;
        if (!acc[type]) {
          acc[type] = { document_type: type, cantidad: 0, base_imponible: 0, iva: 0, total: 0 };
        }
        acc[type].cantidad += 1;
        acc[type].base_imponible += Number(doc.net_amount) || 0;
        acc[type].iva += Number(doc.tax_amount) || 0;
        acc[type].total += Number(doc.total_amount) || 0;
        return acc;
      }, {} as Record<string, IVARow>);

      setData(Object.values(aggregated));
    } catch (error: any) {
      console.error("Error fetching IVA data:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudieron cargar los datos de IVA",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIVAData();
    // Update URL when period changes
    setSearchParams({ period: selectedPeriod });
  }, [selectedPeriod]);

  // Calculate totals
  const totals = data.reduce(
    (acc, row) => ({
      cantidad: acc.cantidad + row.cantidad,
      base_imponible: acc.base_imponible + row.base_imponible,
      iva: acc.iva + row.iva,
      total: acc.total + row.total,
    }),
    { cantidad: 0, base_imponible: 0, iva: 0, total: 0 }
  );

  // Format currency
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("es-CL", {
      style: "currency",
      currency: "CLP",
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Export to Excel
  const handleExport = () => {
    const [year, month] = selectedPeriod.split("-");
    const monthName = format(new Date(parseInt(year), parseInt(month) - 1), "MMMM", { locale: es });

    const exportData = data.map((row) => ({
      "Código SII": documentTypeLabels[row.document_type]?.code || "",
      "Tipo Documento": documentTypeLabels[row.document_type]?.label || row.document_type,
      Cantidad: row.cantidad,
      "Base Imponible": row.base_imponible,
      "IVA 19%": row.iva,
      Total: row.total,
    }));

    // Add totals row
    exportData.push({
      "Código SII": "",
      "Tipo Documento": "TOTAL",
      Cantidad: totals.cantidad,
      "Base Imponible": totals.base_imponible,
      "IVA 19%": totals.iva,
      Total: totals.total,
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    worksheet["!cols"] = [
      { wch: 12 }, { wch: 25 }, { wch: 10 }, { wch: 18 }, { wch: 15 }, { wch: 15 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Reporte IVA");
    XLSX.writeFile(workbook, `reporte-iva-${monthName}-${year}.xlsx`);

    toast({
      title: "Reporte exportado",
      description: `Reporte IVA de ${monthName} ${year} descargado`,
    });
  };

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
                <FileText className="h-6 w-6" />
                Reporte de IVA
              </h1>
              <p className="text-muted-foreground mt-1">
                Resumen para declaración mensual F29 SII
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

        {/* Main Table */}
        <Card>
          <CardHeader>
            <CardTitle>Resumen por Tipo de Documento</CardTitle>
            <CardDescription>
              Documentos tributarios emitidos en el período seleccionado
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : data.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No hay documentos tributarios en este período
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código SII</TableHead>
                    <TableHead>Tipo Documento</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Base Imponible</TableHead>
                    <TableHead className="text-right">IVA 19%</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => (
                    <TableRow key={row.document_type}>
                      <TableCell className="font-mono">
                        {documentTypeLabels[row.document_type]?.code || "—"}
                      </TableCell>
                      <TableCell>
                        {documentTypeLabels[row.document_type]?.label || row.document_type}
                      </TableCell>
                      <TableCell className="text-right">{row.cantidad}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.base_imponible)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.iva)}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(row.total)}</TableCell>
                    </TableRow>
                  ))}
                  {/* Totals row */}
                  <TableRow className="border-t-2 bg-muted/50 font-semibold">
                    <TableCell></TableCell>
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right">{totals.cantidad}</TableCell>
                    <TableCell className="text-right">{formatCurrency(totals.base_imponible)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(totals.iva)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(totals.total)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>IVA Débito Fiscal</CardDescription>
              <CardTitle className="text-2xl text-green-600">
                {formatCurrency(totals.iva)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Suma de IVA de todos los documentos emitidos
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Base Imponible</CardDescription>
              <CardTitle className="text-2xl">
                {formatCurrency(totals.base_imponible)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Ventas netas (sin IVA)
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Documentos Emitidos</CardDescription>
              <CardTitle className="text-2xl">{totals.cantidad}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Boletas, facturas y notas de crédito
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
