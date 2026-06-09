import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent } from "@/components/ui/card";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "@/hooks/use-toast";
import {
  FileText,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  SlidersHorizontal,
} from "lucide-react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";

const PAGE_SIZE = 50;

type DocumentType = "all" | "boleta" | "factura" | "nota_credito" | "nota_debito" | "factura_exenta";
type StatusFilter = "all" | "issued" | "voided";
type SalesChannelFilter = "all" | "MARKETPLACE" | "B2B";

interface TaxDocument {
  id: string;
  document_type: string;
  document_number: string;
  document_date: string;
  client_name: string | null;
  total_amount: number;
  status: string | null;
  sales_channel: string | null;
  detected_channel: string | null;
  external_url: string | null;
  order_tax_documents: { id: string; match_source: string | null }[];
}

// Current month as default: "yyyy-MM"
const currentPeriod = format(new Date(), "yyyy-MM");

const generatePeriodOptions = () => {
  const options = [{ value: "all", label: "Todos los períodos" }];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const date = subMonths(now, i);
    const value = format(date, "yyyy-MM");
    const label = format(date, "MMMM yyyy", { locale: es });
    options.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return options;
};

const periodOptions = generatePeriodOptions();

// Build date range from "yyyy-MM" string safely (avoids UTC timezone shift)
function periodToDateRange(period: string): { from: string; to: string } | null {
  if (period === "all") return null;
  const [y, m] = period.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  return { from: format(start, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
}

const DOC_TYPE_LABELS: Record<string, string> = {
  boleta: "Boleta",
  factura: "Factura",
  nota_credito: "N. Crédito",
  nota_debito: "N. Débito",
  factura_exenta: "Fact. Exenta",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  boleta: "bg-slate-100 text-slate-700",
  factura: "bg-blue-100 text-blue-700",
  nota_credito: "bg-red-100 text-red-700",
  nota_debito: "bg-orange-100 text-orange-700",
  factura_exenta: "bg-purple-100 text-purple-700",
};

const CHANNEL_CONFIG: Record<string, { label: string; className: string }> = {
  meli:      { label: "MercadoLibre", className: "bg-yellow-100 text-yellow-800" },
  falabella: { label: "Falabella",    className: "bg-green-100 text-green-800" },
  paris:     { label: "Paris",        className: "bg-blue-100 text-blue-800" },
  ripley:    { label: "Ripley",       className: "bg-purple-100 text-purple-800" },
  amazon:    { label: "Amazon",       className: "bg-orange-100 text-orange-800" },
  shopify:   { label: "Shopify",      className: "bg-lime-100 text-lime-800" },
  linio:     { label: "Linio",        className: "bg-red-100 text-red-800" },
  rappi:     { label: "Rappi",        className: "bg-pink-100 text-pink-800" },
  walmart:   { label: "Walmart",      className: "bg-cyan-100 text-cyan-800" },
};

const formatCLP = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const formatDate = (d: string) => format(new Date(d + "T12:00:00"), "dd/MM/yy");

function LinkageBadge({ doc }: { doc: TaxDocument }) {
  if (doc.status === "voided") return <span className="text-xs text-muted-foreground">Anulado</span>;
  const links = doc.order_tax_documents || [];
  if (links.length === 0) return <Badge variant="outline" className="text-xs text-muted-foreground">Pendiente</Badge>;
  const src = links[0]?.match_source;
  if (src === "AUTO_CONSOLIDATED" || src === "MANUAL_CONSOLIDATED")
    return <Badge className="text-xs bg-green-100 text-green-700">Consolidado</Badge>;
  if (src?.startsWith("MANUAL"))
    return <Badge className="text-xs bg-blue-100 text-blue-700">Manual</Badge>;
  return <Badge className="text-xs bg-green-100 text-green-700">Auto</Badge>;
}

export default function BsaleDocuments() {
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState(currentPeriod);
  const [documentType, setDocumentType] = useState<DocumentType>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [salesChannel, setSalesChannel] = useState<SalesChannelFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [showExtraFilters, setShowExtraFilters] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [period, documentType, statusFilter, salesChannel, debouncedSearch]);

  // Main documents query — explicit column list, NO raw_data (big JSONB)
  const { data: documentsData, isLoading, refetch } = useQuery({
    queryKey: ["bsale-docs", page, period, documentType, statusFilter, salesChannel, debouncedSearch],
    queryFn: async () => {
      let q = supabase
        .from("tax_documents")
        .select(
          "id, document_type, document_number, document_date, client_name, total_amount, status, sales_channel, detected_channel, external_url, order_tax_documents(id, match_source)",
          { count: "exact" }
        )
        .order("document_date", { ascending: false });

      const range = periodToDateRange(period);
      if (range) q = q.gte("document_date", range.from).lte("document_date", range.to);
      if (documentType !== "all") q = q.eq("document_type", documentType);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      if (salesChannel !== "all") q = q.eq("sales_channel", salesChannel);
      if (debouncedSearch)
        q = q.or(`document_number.ilike.%${debouncedSearch}%,client_name.ilike.%${debouncedSearch}%`);

      const start = (page - 1) * PAGE_SIZE;
      q = q.range(start, start + PAGE_SIZE - 1);

      const { data, error, count } = await q;
      if (error) throw error;
      return { documents: data as TaxDocument[], count: count || 0 };
    },
    staleTime: 30_000,
  });

  // Lightweight stats — only tiny columns, filtered by same period
  const { data: stats } = useQuery({
    queryKey: ["bsale-docs-stats", period],
    queryFn: async () => {
      let q = supabase.from("tax_documents").select("document_type, status");
      const range = periodToDateRange(period);
      if (range) q = q.gte("document_date", range.from).lte("document_date", range.to);
      const { data } = await q;
      const docs = data || [];
      const active = docs.filter(d => d.status !== "voided");
      return {
        total: docs.length,
        boletas: active.filter(d => d.document_type === "boleta").length,
        facturas: active.filter(d => d.document_type === "factura").length,
        anulados: docs.filter(d => d.status === "voided").length,
      };
    },
    staleTime: 30_000,
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { days_back: 90 },
      });
      if (error) throw error;
      const total = data?.summary?.total_upserted ?? data?.summary?.total_fetched ?? 0;
      toast({ title: "Sincronización completada", description: `${total} documentos procesados` });
      refetch();
    } catch (e: any) {
      toast({ title: "Error al sincronizar", description: e?.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const handleReclassify = async () => {
    setReclassifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-bsale-docs", {
        body: { reclassify_b2b: true },
      });
      if (error) throw error;
      toast({ title: "Reclasificación completada", description: `${data?.reclassified || 0} documentos B2B corregidos` });
      refetch();
    } catch (e: any) {
      toast({ title: "Error al reclasificar", description: e?.message, variant: "destructive" });
    } finally {
      setReclassifying(false);
    }
  };

  const documents = documentsData?.documents || [];
  const totalCount = documentsData?.count || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasActiveFilters = documentType !== "all" || statusFilter !== "all" || salesChannel !== "all";

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 p-6">

          {/* ── Header ── */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <FileText className="h-6 w-6 text-primary shrink-0" />
              <h1 className="text-xl font-bold truncate">Documentos Bsale</h1>
            </div>

            {/* Period selector */}
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                {periodOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Search */}
            <div className="relative w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="N° o cliente..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Actions */}
            <Button
              onClick={handleReclassify}
              disabled={reclassifying}
              variant="outline"
              size="sm"
              title="Corrige documentos guardados como B2B"
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 ${reclassifying ? "animate-spin" : ""}`} />
              {reclassifying ? "Corrigiendo..." : "Corregir B2B"}
            </Button>
            <Button onClick={handleSync} disabled={syncing} size="sm">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Sincronizando..." : "Sincronizar"}
            </Button>
          </div>

          {/* ── Stats bar ── */}
          {stats && (
            <p className="text-sm text-muted-foreground mb-3">
              <span className="font-semibold text-foreground">{stats.total.toLocaleString()}</span> documentos
              {" · "}
              <span className="font-semibold text-foreground">{stats.boletas.toLocaleString()}</span> boletas
              {" · "}
              <span className="font-semibold text-foreground">{stats.facturas.toLocaleString()}</span> facturas
              {stats.anulados > 0 && (
                <> · <span className="text-red-500">{stats.anulados} anulados</span></>
              )}
            </p>
          )}

          {/* ── Extra filters (collapsed) ── */}
          <Collapsible open={showExtraFilters} onOpenChange={setShowExtraFilters}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="mb-3 gap-1.5 text-muted-foreground hover:text-foreground">
                <SlidersHorizontal className="h-4 w-4" />
                Filtros
                {hasActiveFilters && (
                  <Badge className="ml-1 h-4 w-4 p-0 flex items-center justify-center text-[10px]">
                    !
                  </Badge>
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-wrap gap-2 mb-4 p-3 bg-muted/30 rounded-lg">
                <Select value={documentType} onValueChange={(v) => setDocumentType(v as DocumentType)}>
                  <SelectTrigger className="w-[150px] h-8 text-sm">
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
                  <SelectTrigger className="w-[140px] h-8 text-sm">
                    <SelectValue placeholder="Estado" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="issued">Emitidos</SelectItem>
                    <SelectItem value="voided">Anulados</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={salesChannel} onValueChange={(v) => setSalesChannel(v as SalesChannelFilter)}>
                  <SelectTrigger className="w-[170px] h-8 text-sm">
                    <SelectValue placeholder="Canal" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los canales</SelectItem>
                    <SelectItem value="MARKETPLACE">Marketplace</SelectItem>
                    <SelectItem value="B2B">B2B / Directa</SelectItem>
                  </SelectContent>
                </Select>

                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-sm"
                    onClick={() => { setDocumentType("all"); setStatusFilter("all"); setSalesChannel("all"); }}
                  >
                    Limpiar filtros
                  </Button>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ── Table ── */}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Tipo</TableHead>
                    <TableHead>Número</TableHead>
                    <TableHead className="w-[90px]">Fecha</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="text-right w-[110px]">Monto</TableHead>
                    <TableHead className="w-[120px]">Canal</TableHead>
                    <TableHead className="w-[100px]">Vinculación</TableHead>
                    <TableHead className="w-[40px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                        Cargando documentos...
                      </TableCell>
                    </TableRow>
                  ) : documents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12">
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          <FileText className="h-8 w-8 opacity-30" />
                          <p>No hay documentos para este período</p>
                          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
                            <RefreshCw className="h-4 w-4 mr-1.5" />
                            Sincronizar ahora
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    documents.map((doc) => {
                      const channelCfg = doc.detected_channel ? CHANNEL_CONFIG[doc.detected_channel] : null;
                      return (
                        <TableRow key={doc.id}>
                          <TableCell>
                            <Badge className={`text-xs ${DOC_TYPE_COLORS[doc.document_type] || ""}`}>
                              {DOC_TYPE_LABELS[doc.document_type] || doc.document_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-sm">{doc.document_number}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{formatDate(doc.document_date)}</TableCell>
                          <TableCell className="max-w-[180px] truncate text-sm">{doc.client_name || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatCLP(doc.total_amount)}</TableCell>
                          <TableCell>
                            {channelCfg ? (
                              <Badge className={`text-xs ${channelCfg.className}`}>{channelCfg.label}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {doc.sales_channel === "MARKETPLACE" ? "Marketplace" : doc.sales_channel || "—"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell><LinkageBadge doc={doc} /></TableCell>
                          <TableCell>
                            {doc.external_url && (
                              <a href={doc.external_url} target="_blank" rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground">
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3">
              <p className="text-sm text-muted-foreground">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} de {totalCount.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm px-2">Pág. {page} / {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
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
