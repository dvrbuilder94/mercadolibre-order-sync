import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, Book, Loader2 } from "lucide-react";
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

// SII document codes
const siiCodes: Record<string, { code: number; label: string }> = {
  boleta: { code: 39, label: "Boleta Electrónica" },
  factura: { code: 33, label: "Factura Electrónica" },
  factura_exenta: { code: 34, label: "Factura Exenta" },
  nota_credito: { code: 61, label: "Nota de Crédito" },
  nota_debito: { code: 56, label: "Nota de Débito" },
};

interface SalesLedgerRow {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  client_tax_id: string | null;
  client_name: string | null;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
}

export default function ReportSalesLedger() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodFromUrl = searchParams.get("period");
  const [selectedPeriod, setSelectedPeriod] = useState(periodFromUrl || format(new Date(), "yyyy-MM"));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SalesLedgerRow[]>([]);
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

  // Fetch sales ledger data
  const fetchSalesLedgerData = async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getDateRange(selectedPeriod);
      
      const { data: taxDocs, error } = await supabase
        .from("tax_documents")
        .select("id, document_type, document_number, document_date, client_tax_id, client_name, net_amount, tax_amount, total_amount")
        .gte("document_date", startDate)
        .lte("document_date", endDate)
        .eq("status", "issued")
        .order("document_date", { ascending: true })
        .order("document_number", { ascending: true });

      if (error) throw error;

      setData((taxDocs || []).map(doc => ({
        id: doc.id,
        document_type: doc.document_type,
        document_number: doc.document_number,
        document_date: doc.document_date,
        client_tax_id: doc.client_tax_id,
        client_name: doc.client_name,
        net_amount: Number(doc.net_amount) || 0,
        tax_amount: Number(doc.tax_amount) || 0,
        total_amount: Number(doc.total_amount) || 0,
      })));
    } catch (error: any) {
      console.error("Error fetching sales ledger:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudo cargar el libro de ventas",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSalesLedgerData();
    setSearchParams({ period: selectedPeriod });
  }, [selectedPeriod]);

  // Calculate totals
  const totals = data.reduce(
    (acc, row) => ({
      net_amount: acc.net_amount + row.net_amount,
      tax_amount: acc.tax_amount + row.tax_amount,
      total_amount: acc.total_amount + row.total_amount,
    }),
    { net_amount: 0, tax_amount: 0, total_amount: 0 }
  );

  // Format currency
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("es-CL", {
      style: "currency",
      currency: "CLP",
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Format RUT for display
  const formatRUT = (rut: string | null) => {
    if (!rut) return "—";
    // Clean and format
    const clean = rut.replace(/[^0-9kK]/g, "");
    if (clean.length < 2) return rut;
    const body = clean.slice(0, -1);
    const dv = clean.slice(-1).toUpperCase();
    return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`;
  };

  // Export to Excel (SII format)
  const handleExport = () => {
    const [year, month] = selectedPeriod.split("-");
    const monthName = format(new Date(parseInt(year), parseInt(month) - 1), "MMMM", { locale: es });

    const exportData = data.map((row) => ({
      "Tipo Doc": siiCodes[row.document_type]?.code || "",
      "N° Documento": row.document_number,
      Fecha: row.document_date,
      RUT: row.client_tax_id || "",
      "Razón Social": row.client_name || "",
      "Monto Neto": row.net_amount,
      IVA: row.tax_amount,
      "Monto Total": row.total_amount,
    }));

    // Add totals row
    exportData.push({
      "Tipo Doc": "",
      "N° Documento": "TOTAL",
      Fecha: "",
      RUT: "",
      "Razón Social": "",
      "Monto Neto": totals.net_amount,
      IVA: totals.tax_amount,
      "Monto Total": totals.total_amount,
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    worksheet["!cols"] = [
      { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 14 },
      { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 15 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Libro de Ventas");
    XLSX.writeFile(workbook, `libro-ventas-${monthName}-${year}.xlsx`);

    toast({
      title: "Libro exportado",
      description: `Libro de ventas de ${monthName} ${year} descargado`,
    });
  };

  // Get badge for document type
  const getDocTypeBadge = (docType: string) => {
    const config = siiCodes[docType];
    if (!config) return <Badge variant="outline">{docType}</Badge>;

    const colors: Record<string, string> = {
      boleta: "bg-blue-100 text-blue-700 border-blue-200",
      factura: "bg-green-100 text-green-700 border-green-200",
      factura_exenta: "bg-purple-100 text-purple-700 border-purple-200",
      nota_credito: "bg-amber-100 text-amber-700 border-amber-200",
      nota_debito: "bg-red-100 text-red-700 border-red-200",
    };

    return (
      <Badge variant="outline" className={colors[docType] || ""}>
        {config.code} - {config.label}
      </Badge>
    );
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
                <Book className="h-6 w-6" />
                Libro de Ventas
              </h1>
              <p className="text-muted-foreground mt-1">
                Formato SII - Boletas, Facturas y Notas de Crédito
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

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Documentos</CardDescription>
              <CardTitle className="text-2xl">{data.length}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Monto Neto</CardDescription>
              <CardTitle className="text-2xl">{formatCurrency(totals.net_amount)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>IVA</CardDescription>
              <CardTitle className="text-2xl text-green-600">{formatCurrency(totals.tax_amount)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Monto Total</CardDescription>
              <CardTitle className="text-2xl">{formatCurrency(totals.total_amount)}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Main Table */}
        <Card>
          <CardHeader>
            <CardTitle>Detalle de Documentos</CardTitle>
            <CardDescription>
              Listado cronológico de documentos tributarios emitidos
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
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tipo</TableHead>
                      <TableHead>N° Doc</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>RUT</TableHead>
                      <TableHead>Razón Social</TableHead>
                      <TableHead className="text-right">Neto</TableHead>
                      <TableHead className="text-right">IVA</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{getDocTypeBadge(row.document_type)}</TableCell>
                        <TableCell className="font-mono">{row.document_number}</TableCell>
                        <TableCell>{format(new Date(row.document_date), "dd/MM/yyyy")}</TableCell>
                        <TableCell className="font-mono text-sm">{formatRUT(row.client_tax_id)}</TableCell>
                        <TableCell className="max-w-[200px] truncate">{row.client_name || "—"}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.net_amount)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.tax_amount)}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(row.total_amount)}</TableCell>
                      </TableRow>
                    ))}
                    {/* Totals row */}
                    <TableRow className="border-t-2 bg-muted/50 font-semibold">
                      <TableCell colSpan={5}>TOTAL</TableCell>
                      <TableCell className="text-right">{formatCurrency(totals.net_amount)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(totals.tax_amount)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(totals.total_amount)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
