import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CheckCircle2, AlertCircle, XCircle, Lock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ClosingStatusBannerProps {
  status: 'green' | 'yellow' | 'red';
  message: string;
  isClosed: boolean;
  closedAt?: string;
  observations?: string;
  blockingCount?: number;
  selectedPeriod?: string;
}

export const ClosingStatusBanner = ({ 
  status, 
  message, 
  isClosed, 
  closedAt,
  observations,
  blockingCount,
  selectedPeriod
}: ClosingStatusBannerProps) => {
  if (isClosed) {
    return (
      <Alert className="border-primary/50 bg-primary/5">
        <Lock className="h-4 w-4" />
        <AlertTitle className="text-primary">Período Cerrado</AlertTitle>
        <AlertDescription>
          <div className="space-y-1">
            <p>
              Cerrado el {closedAt ? format(new Date(closedAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es }) : "—"}
            </p>
            {observations && (
              <p className="text-muted-foreground italic">
                Observaciones: {observations}
              </p>
            )}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const config = {
    green: {
      icon: CheckCircle2,
      title: "Listo para cerrar",
      className: "border-green-500/50 bg-green-500/5",
      iconClassName: "text-green-500",
      badgeColor: "bg-green-500",
    },
    yellow: {
      icon: AlertCircle,
      title: "Cerrable con observaciones",
      className: "border-amber-500/50 bg-amber-500/5",
      iconClassName: "text-amber-500",
      badgeColor: "bg-amber-500",
    },
    red: {
      icon: XCircle,
      title: "No se puede cerrar",
      className: "border-red-500/50 bg-red-500/5",
      iconClassName: "text-red-500",
      badgeColor: "bg-red-500",
    },
  }[status];

  const Icon = config.icon;

  return (
    <Alert className={config.className}>
      <Icon className={`h-4 w-4 ${config.iconClassName}`} />
      <AlertTitle className={`${config.iconClassName} flex items-center gap-2`}>
        <span className={`inline-block w-2 h-2 rounded-full ${config.badgeColor}`} />
        {config.title}
      </AlertTitle>
      <AlertDescription className="mt-1">{message}</AlertDescription>
    </Alert>
  );
};
