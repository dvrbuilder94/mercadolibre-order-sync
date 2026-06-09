import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { toast } from "@/hooks/use-toast";
import { 
  FileText, 
  Receipt, 
  FileX, 
  Link2, 
  ExternalLink, 
  RefreshCw, 
  Search,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { format, endOfMonth, startOfMonth, subMonths } from "date-fns";
import { es } from "date-fns/locale";

const PAGE_SIZE = 25;

type DocumentType = "all" | "boleta" | "factura" | "nota_credito" | "nota_debito" | "factura_exenta";
type StatusFilter = "all" | "issued" | "voided";
type SalesChannelFilter = "all" | "MARKETPLACE" | "B2B";

interface TaxDocument {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  client_name: string | null;
  client_tax_id: string | null;
  total_amount: number;
  status: string | null;
  sales_channel: string | null;
  detected_channel: string | null;
  external_url: string | null;
  order_tax_documents: { id: string; match_source: string | null }[];
}

interface Stats {
  boletas: number;
  facturas: number;
  anulados: number;
  vinculados: number;
  totalMarketplace: number;
  vinculadosMarketplace: number;
  totalB2B: number;
}

// Generate period options for last 12 months
const generatePeriodOptions = () => {
  const options = [{ value: "all", label: "Todos los períodos" }];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const date = subMonths(now, i);
    const value = format(date, "yyyy-MM");
    const label = format(date, "MMMM yyyy", { locale: es });
    options.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return options;
};

const periodOptions = generatePeriodOptions();

const getDocTypeBadge = (type: string) => {
  const config: Record<string, { label: string; className: string }> = {
    factura: { label: "Factura", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
    boleta: { label: "Boleta", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
    nota_credito: { label: "Nota Crédito", className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" },
    nota_debito: { label: "Nota Débito", className: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" },
    factura_exenta: { label: "Fact. Exenta", className: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300" },
  };
  const c = config[type] || { label: type, className: "" };
  return <Badge className={c.className}>{c.label}</Badge>;
};

const getStatusBadge = (status: string | null) => {
  if (status === "voided") {
    return <Badge variant="destructive">Anulado</Badge>;
  }
  return <Badge variant="secondary">Emitido</Badge>;
};

const getLinkageBadge = (doc: TaxDocument) => {
  if (doc.status === "voided") {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  
  const links = doc.order_tax_documents || [];
  if (links.length === 0) {
    return <Badge variant="outline" className="text-muted-foreground">Pendiente</Badge>;
  }
  
  const matchSource = links[0]?.match_source;
  if (matchSource === "AUTO_CONSOLIDATED") {
    return <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Consolidado</Badge>;
  }
  if (matchSource === "MANUAL" || matchSource === "MANUAL_CONSOLIDATED") {
    return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">Manual</Badge>;
  }
  return <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Auto</Badge>;
};

const getChannelBadge = (channel: string | null) => {
  if (!channel) return null;
  const config: Record<string, { label: string; className: string }> = {
    meli:     { label: "MercadoLibre", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300" },
    falabella:{ label: "Falabella",    className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" },
    paris:    { label: "Paris",        className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300" },
    ripley:   { label: "Ripley",       className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300" },
    amazon:   { label: "Amazon",       className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300" },
    shopify:  { label: "Shopify",      className: "bg-lime-100 text-lime-800 dark:bg-lime-900 dark:text-lime-300" },
    linio:    { label: "Linio",        className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300" },
    rappi:    { label: "Rappi",        className: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300" },
    walmart:  { label: "Walmart",      className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300" },
  };
  const c = config[channel] || { label: channel, className: "bg-gray-100 text-gray-700" };
  return <Badge className={c.className}>{c.label}</Badge>;
};

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatDate = (dateStr: string) => {
  return format(new Date(dateStr), "dd/MM/yyyy");
};

export default function BsaleDocuments() {
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState("all");
  const [documentType, setDocumentType] = useState<DocumentType>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [salesChannel, setSalesChannel] = useState<SalesChannelFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [period, documentType, statusFilter, salesChannel, debouncedSearch]);

  // Fetch documents
  const { data: documentsData, isLoading, refetch } = useQuery({
    queryKey: ["bsale-documents", page, period, documentType, statusFilter, salesChannel, debouncedSearch],
    queryFn: async () => {
      let query = supabase
        .from("tax_documents")
        .select("*, order_tax_documents(id, match_source)", { count: "exact" })
        .order("document_date", { ascending: false });

      if (documentType !== "all") {
        query = query.eq("document_type", documentType);
      }
      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (period !== "all") {
        // Parse year/month directly to avoid UTC→local timezone shift
        // (new Date("2026-06-01") is UTC midnight, which in Chile = May 31 local)
        const [y, m] = period.split("-").map(Number);
        const startDate = new Date(y, m - 1, 1);
        const endDate = new Date(y, m, 0); // day 0 of next month = last day of this month
        query = query
          .gte("document_date", format(startDate, "yyyy-MM-dd"))
          .lte("document_date", format(endDate, "yyyy-MM-dd"));
      }
      if (salesChannel !== "all") {
        query = query.eq("sales_channel", salesChannel);
      }
      if (debouncedSearch) {
        query = query.or(
          `document_number.ilike.%${debouncedSearch}%,client_name.ilike.%${debouncedSearch}%`
        );
      }

      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;
      query = query.range(start, end);

      const { data, error, count } = await query;
      if (error) throw error;
      return { documents: data as TaxDocument[], count: count || 0 };
    },
  });

  // Fetch stats
  const { data: stats } = useQuery({
    queryKey: ["bsale-documents-stats", period, salesChannel],
    queryFn: async () => {
      let baseQuery = supabase.from("tax_documents").select("id, document_type, status, sales_channel");
      
      if (period !== "all") {
        const [y, m] = period.split("-").map(Number);
        const startDate = new Date(y, m - 1, 1);
        const endDate = new Date(y, m, 0);
        baseQuery = baseQuery
          .gte("document_date", format(startDate, "yyyy-MM-dd"))
          .lte("document_date", format(endDate, "yyyy-MM-dd"));
      }

      const { data: docs, error } = await baseQuery;
      if (error) throw error;

      // Get linked document IDs
      const { data: links } = await supabase
        .from("order_tax_documents")
        .select("tax_document_id");
      
      const linkedIds = new Set((links || []).map(l => l.tax_document_id));

      const result: Stats = {
        boletas: 0,
        facturas: 0,
        anulados: 0,
        vinculados: 0,
        totalMarketplace: 0,
        vinculadosMarketplace: 0,
        totalB2B: 0,
      };

      (docs || []).forEach((doc) => {
        // Count by sales channel
        if (doc.sales_channel === 'MARKETPLACE') {
          result.totalMarketplace++;
          if (linkedIds.has(doc.id) && doc.status !== 'voided') {
            result.vinculadosMarketplace++;
          }
        } else if (doc.sales_channel === 'B2B') {
          result.totalB2B++;
        }
        
        if (doc.status === "voided") {
          result.anulados++;
        } else {
          if (doc.document_type === "boleta") result.boletas++;
          if (doc.document_type === "factura") result.facturas++;
          if (linkedIds.has(doc.id)) result.vinculados++;
        }
      });

      return result;
    },
  });

  const handleReclassify = async () => {
    setReclassifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { reclassify_b2b: true },
      });
      if (error) throw error;
      toast({
        title: "Reclasificación completada",
        description: `${data?.reclassified || 0} documentos B2B corregidos a Marketplace`,
      });
      refetch();
    } catch (e: any) {
      toast({ title: "Error al reclasificar", description: e?.message, variant: "destructive" });
    } finally {
      setReclassifying(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs");
      if (error) throw error;
      const total = data?.summary?.total_upserted ?? data?.summary?.total_fetched ?? data?.synced ?? 0;
      toast({
        title: "Sincronización completada",
        description: `Se procesaron ${total} documentos desde Bsale`,
      });
      refetch();
    } catch (e) {
      toast({
        title: "Error al sincronizar",
        description: "No se pudo completar la sincronización con Bsale",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  const documents = documentsData?.documents || [];
  const totalCount = documentsData?.count || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-primary" />
              <div>
                <h1 className="text-2xl font-bold">Documentos Bsale</h1>
                <p className="text-muted-foreground text-sm">
                  Documentos tributarios sincronizados desde Bsale
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent>
                  {periodOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleReclassify} disabled={reclassifying} variant="outline" size="sm" title="Corrige documentos guardados como B2B incorrectamente">
                <RefreshCw className={`h-4 w-4 mr-2 ${reclassifying ? "animate-spin" : ""}`} />
                {reclassifying ? "Corrigiendo..." : "Corregir B2B"}
              </Button>
              <Button onClick={handleSync} disabled={syncing} variant="outline">
                <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
                Sincronizar
              </Button>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Vinculados Marketplace</CardTitle>
                <Link2 className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">
                  {stats?.vinculadosMarketplace?.toLocaleString() || 0} / {stats?.totalMarketplace?.toLocaleString() || 0}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Documentos de marketplace conciliados
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Documentos B2B</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.totalB2B?.toLocaleString() || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Ventas directas (no marketplace)
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Boletas</CardTitle>
                <Receipt className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.boletas?.toLocaleString() || 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Facturas</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.facturas?.toLocaleString() || 0}</div>
              </CardContent>
            </Card>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-3 mb-4">
            <Select value={documentType} onValueChange={(v) => setDocumentType(v as DocumentType)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                <SelectItem value="boleta">Boleta</SelectItem>
                <SelectItem value="factura">Factura</SelectItem>
                <SelectItem value="nota_credito">Nota Crédito</SelectItem>
                <SelectItem value="nota_debito">Nota Débito</SelectItem>
                <SelectItem value="factura_exenta">Factura Exenta</SelectItem>
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="issued">Emitidos</SelectItem>
                <SelectItem value="voided">Anulados</SelectItem>
              </SelectContent>
            </Select>

            <Select value={salesChannel} onValueChange={(v) => setSalesChannel(v as SalesChannelFilter)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Canal de Venta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los canales</SelectItem>
                <SelectItem value="MARKETPLACE">Solo Marketplace</SelectItem>
                <SelectItem value="B2B">Solo B2B / Directa</SelectItem>
              </SelectContent>
            </Select>

            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por número o cliente..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Table */}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Número</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>RUT</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead>Canal</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Vinculación</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                        Cargando documentos...
                      </TableCell>
                    </TableRow>
                  ) : documents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                        No se encontraron documentos
                      </TableCell>
                    </TableRow>
                  ) : (
                    documents.map((doc) => (
                      <TableRow key={doc.id}>
                        <TableCell>{getDocTypeBadge(doc.document_type)}</TableCell>
                        <TableCell className="font-mono">{doc.document_number}</TableCell>
                        <TableCell>{formatDate(doc.document_date)}</TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {doc.client_name || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {doc.client_tax_id || "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(doc.total_amount)}
                        </TableCell>
                        <TableCell>
                          {doc.detected_channel ? getChannelBadge(doc.detected_channel) : 
                           doc.sales_channel === 'MARKETPLACE' ? <Badge variant="outline">Marketplace</Badge> :
                           <span className="text-muted-foreground text-sm">B2B</span>}
                        </TableCell>
                        <TableCell>{getStatusBadge(doc.status)}</TableCell>
                        <TableCell>{getLinkageBadge(doc)}</TableCell>
                        <TableCell>
                          {doc.external_url && (
                            <Button variant="ghost" size="sm" asChild>
                              <a href={doc.external_url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Mostrando {(page - 1) * PAGE_SIZE + 1}–
                {Math.min(page * PAGE_SIZE, totalCount)} de {totalCount.toLocaleString()}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Página {page} de {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    </SidebarProvider>
  );
}
