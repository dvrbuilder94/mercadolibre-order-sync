import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { Link2, Download, Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import * as XLSX from "xlsx";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface TaxCrossEntry {
  order_date: string;
  reference_id: string;
  customer_name: string;
  order_amount: number;
  document_type: string | null;
  document_number: string | null;
  doc_total: number | null;
  match_source: string | null;
  status: "OK" | "SIN_DOC" | "REVISAR";
}

interface TaxCrossStats {
  totalSales: number;
  withDocument: number;
  withoutDocument: number;
  withDifference: number;
}

type FilterStatus = "all" | "sin_doc" | "revisar" | "ok";

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

const getDocumentTypeLabel = (type: string | null): string => {
  const labels: Record<string, string> = {
    boleta: "Boleta",
    factura: "Factura",
    factura_exenta: "Fact. Exenta",
    nota_credito: "Nota de Crédito",
    nota_debito: "Nota de Débito",
  };
  return labels[type || ""] || type || "—";
};

const getStatusBadge = (status: TaxCrossEntry["status"]) => {
  switch (status) {
    case "OK":
      return (
        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          OK
        </Badge>
      );
    case "SIN_DOC":
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          Sin Doc
        </Badge>
      );
    case "REVISAR":
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
          <AlertCircle className="h-3 w-3 mr-1" />
          Revisar
        </Badge>
      );
  }
};

export default function ReportTaxCross() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periodParam = searchParams.get("period");
  const [selectedPeriod, setSelectedPeriod] = useState(
    periodParam || format(new Date(), "yyyy-MM")
  );
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [entries, setEntries] = useState<TaxCrossEntry[]>([]);
  const [filteredEntries, setFilteredEntries] = useState<TaxCrossEntry[]>([]);
  const [stats, setStats] = useState<TaxCrossStats>({
    totalSales: 0,
    withDocument: 0,
    withoutDocument: 0,
    withDifference: 0,
  });
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");

  const periodOptions = generatePeriodOptions();

  const fetchTaxCrossData = useCallback(async (period: string) => {
    setLoading(true);
    try {
      const [year, month] = period.split("-").map(Number);
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      // Fetch orders with linked tax documents
      const { data: orders, error: ordersError } = await supabase
        .from("orders")
        .select(`
          order_date,
          external_sale_id,
          order_id,
          customer_name,
          gross_amount,
          order_tax_documents (
            match_source,
            tax_document_id
          )
        `)
        .gte("order_date", startDate.toISOString())
        .lte("order_date", endDate.toISOString())
        .neq("status", "cancelled")
        .order("order_date", { ascending: false });

      if (ordersError) throw ordersError;

      if (!orders || orders.length === 0) {
        setEntries([]);
        setStats({ totalSales: 0, withDocument: 0, withoutDocument: 0, withDifference: 0 });
        setLoading(false);
        return;
      }

      // Get all tax document IDs
      const taxDocIds = orders
        .flatMap((o) => o.order_tax_documents || [])
        .map((otd) => otd.tax_document_id)
        .filter(Boolean);

      // Fetch tax document details
      let taxDocsMap: Record<string, any> = {};
      if (taxDocIds.length > 0) {
        const { data: taxDocs } = await supabase
          .from("tax_documents")
          .select("id, document_type, document_number, total_amount")
          .in("id", taxDocIds);

        taxDocsMap = (taxDocs || []).reduce((acc, doc) => {
          acc[doc.id] = doc;
          return acc;
        }, {} as Record<string, any>);
      }

      // Build entries with status
      const entriesData: TaxCrossEntry[] = orders.map((order) => {
        const linkedDoc = order.order_tax_documents?.[0];
        const taxDoc = linkedDoc ? taxDocsMap[linkedDoc.tax_document_id] : null;
        const orderAmount = Number(order.gross_amount) || 0;
        const docTotal = taxDoc ? Number(taxDoc.total_amount) : null;

        let status: TaxCrossEntry["status"];
        if (!taxDoc) {
          status = "SIN_DOC";
        } else if (Math.abs(orderAmount - (docTotal || 0)) < 100) {
          status = "OK";
        } else {
          status = "REVISAR";
        }

        return {
          order_date: order.order_date,
          reference_id: order.external_sale_id || order.order_id,
          customer_name: order.customer_name,
          order_amount: orderAmount,
          document_type: taxDoc?.document_type || null,
          document_number: taxDoc?.document_number || null,
          doc_total: docTotal,
          match_source: linkedDoc?.match_source || null,
          status,
        };
      });

      setEntries(entriesData);

      // Calculate stats
      const withDoc = entriesData.filter((e) => e.status !== "SIN_DOC").length;
      const withoutDoc = entriesData.filter((e) => e.status === "SIN_DOC").length;
      const withDiff = entriesData.filter((e) => e.status === "REVISAR").length;

      setStats({
        totalSales: entriesData.length,
        withDocument: withDoc,
        withoutDocument: withoutDoc,
        withDifference: withDiff,
      });
    } catch (error) {
      console.error("Error fetching tax cross data:", error);
      toast({
        title: "Error",
        description: "No se pudieron cargar los datos de cruce tributario",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTaxCrossData(selectedPeriod);
  }, [selectedPeriod, fetchTaxCrossData]);

  useEffect(() => {
    // Apply filter
    if (filterStatus === "all") {
      setFilteredEntries(entries);
    } else {
      const statusMap: Record<FilterStatus, TaxCrossEntry["status"]> = {
        all: "OK",
        sin_doc: "SIN_DOC",
        revisar: "REVISAR",
        ok: "OK",
      };
      setFilteredEntries(entries.filter((e) => e.status === statusMap[filterStatus]));
    }
  }, [entries, filterStatus]);

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
        { Concepto: "Total Ventas", Valor: stats.totalSales },
        { Concepto: "Con Documento", Valor: stats.withDocument },
        { Concepto: "Sin Documento", Valor: stats.withoutDocument },
        { Concepto: "Con Diferencia", Valor: stats.withDifference },
        { Concepto: "% Documentado", Valor: `${stats.totalSales > 0 ? ((stats.withDocument / stats.totalSales) * 100).toFixed(1) : 0}%` },
      ];
      const summarySheet = XLSX.utils.json_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");

      // Detail sheet
      const detailData = entries.map((e) => ({
        Fecha: format(new Date(e.order_date), "dd/MM/yyyy"),
        Referencia: e.reference_id,
        Cliente: e.customer_name,
        "Monto Venta": e.order_amount,
        "Tipo Doc": getDocumentTypeLabel(e.document_type),
        "N° Doc": e.document_number || "—",
        "Total Doc": e.doc_total || "—",
        "Método Vinculación": e.match_source || "—",
        Estado: e.status,
      }));
      const detailSheet = XLSX.utils.json_to_sheet(detailData);
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalle");

      const [year, month] = selectedPeriod.split("-");
      const fileName = `cruce-tributario-${year}-${month}.xlsx`;
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
              <Link2 className="h-6 w-6" />
              Cruce Tributario
            </h1>
            <p className="text-muted-foreground mt-1">
              Auditoría de vinculación Venta ↔ Documento SII
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

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Ventas
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-3xl font-bold">{stats.totalSales}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Con Documento
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-bold text-green-600">{stats.withDocument}</p>
                  <span className="text-sm text-muted-foreground">
                    ({stats.totalSales > 0 ? ((stats.withDocument / stats.totalSales) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Sin Documento
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-bold text-destructive">{stats.withoutDocument}</p>
                  <span className="text-sm text-muted-foreground">
                    ({stats.totalSales > 0 ? ((stats.withoutDocument / stats.totalSales) * 100).toFixed(1) : 0}%)
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filter and Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Detalle de Vinculación</CardTitle>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as FilterStatus)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Filtrar por estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="sin_doc">🔴 Sin documento</SelectItem>
                <SelectItem value="revisar">🟡 Con diferencia</SelectItem>
                <SelectItem value="ok">🟢 OK</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filteredEntries.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">
                {entries.length === 0
                  ? "No hay ventas para este período"
                  : "No hay resultados con el filtro seleccionado"}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Referencia</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Venta</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead className="text-right">Total Doc</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.slice(0, 100).map((entry, idx) => (
                      <TableRow key={`${entry.reference_id}-${idx}`}>
                        <TableCell className="whitespace-nowrap">
                          {format(new Date(entry.order_date), "dd/MM/yy")}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {entry.reference_id}
                        </TableCell>
                        <TableCell className="max-w-[150px] truncate">
                          {entry.customer_name}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(entry.order_amount)}
                        </TableCell>
                        <TableCell>
                          {entry.document_type ? (
                            <span>
                              {getDocumentTypeLabel(entry.document_type)} #{entry.document_number}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {entry.doc_total ? formatCurrency(entry.doc_total) : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          {getStatusBadge(entry.status)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {filteredEntries.length > 100 && (
                  <p className="text-center py-4 text-sm text-muted-foreground">
                    Mostrando 100 de {filteredEntries.length} registros. Exporta para ver todos.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
