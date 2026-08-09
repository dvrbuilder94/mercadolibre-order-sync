import { ReactNode } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

// Diálogo genérico de conexión: primero un mini manual con los pasos exactos
// que pide la documentación oficial del proveedor y recién después el
// formulario con las credenciales.

export interface GuideStep {
  title: string;
  body: ReactNode;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle: string;
  docsUrl: string;
  docsLabel: string;
  steps: GuideStep[];
  note?: ReactNode;
  form: ReactNode;
  error?: string | null;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: () => void;
}

export function CopyableValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/50 p-2">
      <code className="flex-1 break-all text-xs">{value}</code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={label}
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast.success("Copiado al portapapeles");
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function ConnectGuideDialog({
  open, onOpenChange, title, subtitle, docsUrl, docsLabel,
  steps, note, form, error, submitting, submitLabel = "Guardar y validar", onSubmit,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <ol className="space-y-3 list-decimal pl-5 text-sm text-muted-foreground">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="font-medium text-foreground">{s.title}</span>
              <div className="mt-1">{s.body}</div>
            </li>
          ))}
        </ol>

        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
        >
          {docsLabel} <ExternalLink className="h-4 w-4" />
        </a>

        {note && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            {note}
          </p>
        )}

        <div className="space-y-3 border-t pt-4">{form}</div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          Las credenciales quedan guardadas solo en tu cuenta y se usan en modo lectura
          para traer tus ventas y documentos.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}