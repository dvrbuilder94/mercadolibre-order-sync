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
  ChevronRight,
  Sparkles,
  Loader2,
  Copy,
  Check
} from "lucide-react";
import { format, subMonths } from "date-fns";
import { es } from "date-fns/locale";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
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
  const [includeRaw, setIncludeRaw] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);

  const llmPrompt = `Adjunto un JSON con ventas de MercadoLibre, documentos tributarios Bsale y pagos del período ${selectedPeriod}.

Analiza las coincidencias entre ventas y documentos usando esta jerarquía:
1. Match fuerte: mismo RUT (customer_tax_id == client_tax_id) + monto bruto ±1% + fecha ±3 días.
2. Match medio: mismo monto + fecha ±3 días (sin RUT confiable).
3. Match débil: mismo RUT + fecha ±7 días con tolerancia de monto mayor.

Devuelve 3 tablas en markdown:
- Coincidencias confiables (orden ↔ documento)
- Ambiguas (múltiples candidatos)
- Huérfanas (ventas sin doc y docs sin venta)

Considera que existing_links.order_tax_documents son los matches ya hechos por el sistema — valida si son correctos.`;

  const handleExportSample = async () => {
    setExporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sesión expirada");

      const url = `https://opdclqitvxyqzeqzegih.supabase.co/functions/v1/export-monthly-sample`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ period: selectedPeriod, include_raw: includeRaw }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `quadra-sample-${selectedPeriod}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: "Muestra descargada", description: `${sizeMB} MB · listo para subir al LLM` });
    } catch (e: any) {
      toast({ title: "Error al exportar", description: e?.message ?? "Error desconocido", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(llmPrompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

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

        {/* Muestra para análisis externo en LLM */}
        <div className="pt-4">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Análisis externo (Grok / ChatGPT / Claude)
          </h2>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Muestra mensual en JSON</CardTitle>
              <CardDescription>
                Descarga un archivo único con todas las ventas, documentos Bsale, pagos y matches del período seleccionado. Súbelo a tu LLM con el prompt sugerido para validar coincidencias por fuera del sistema.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="include-raw"
                  checked={includeRaw}
                  onCheckedChange={(v) => setIncludeRaw(!!v)}
                />
                <Label htmlFor="include-raw" className="text-sm cursor-pointer">
                  Incluir <code className="text-xs">raw_data</code> (más pesado, útil para auditoría profunda)
                </Label>
              </div>
              <Button onClick={handleExportSample} disabled={exporting} className="w-full sm:w-auto">
                {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                Descargar muestra JSON · {selectedPeriod}
              </Button>

              <div className="border rounded-lg p-3 bg-muted/40">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Prompt sugerido</span>
                  <Button variant="ghost" size="sm" onClick={copyPrompt}>
                    {promptCopied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                    {promptCopied ? "Copiado" : "Copiar"}
                  </Button>
                </div>
                <pre className="text-xs whitespace-pre-wrap text-muted-foreground font-mono">{llmPrompt}</pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
