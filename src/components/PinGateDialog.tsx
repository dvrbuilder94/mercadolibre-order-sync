import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PinGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void | Promise<void>;
  title?: string;
  description?: string;
}

export function PinGateDialog({
  open,
  onOpenChange,
  onVerified,
  title = "Verificación de seguridad",
  description = "Ingresa el PIN de 6 dígitos de la organización para continuar.",
}: PinGateDialogProps) {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPin("");
    setError(null);
    setHasPin(null);
    (async () => {
      const { data, error: rpcError } = await (supabase as any).rpc("has_org_pin");
      if (rpcError) {
        setError("No se pudo comprobar la configuración de seguridad.");
        setHasPin(false);
        return;
      }
      setHasPin(Boolean(data));
    })();
  }, [open]);

  const verify = async () => {
    if (!/^\d{6}$/.test(pin)) {
      setError("El PIN debe tener exactamente 6 dígitos.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const { data, error: rpcError } = await (supabase as any).rpc("verify_org_pin", { p_pin: pin });
      if (rpcError || !data) {
        setError("PIN incorrecto. Después de 5 intentos se bloquea por 15 minutos.");
        setPin("");
        return;
      }
      onOpenChange(false);
      await onVerified();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-5 w-5 text-slate-600" />
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {hasPin === false ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Esta organización todavía no tiene PIN de seguridad configurado.
            </div>
            <button
              onClick={() => { onOpenChange(false); navigate("/perfil"); }}
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Configurar PIN en Perfil
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor="org-pin" className="text-xs font-medium text-slate-600">PIN de organización</label>
              <input
                id="org-pin"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => e.key === "Enter" && verify()}
                autoFocus
                autoComplete="off"
                placeholder="••••••"
                className="mt-1 w-full rounded-md border px-3 py-2 text-center text-xl tracking-[0.45em]"
              />
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              onClick={verify}
              disabled={checking || hasPin === null || pin.length !== 6}
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {checking ? "Verificando..." : "Verificar y continuar"}
            </button>
            <p className="text-[11px] text-slate-400 text-center">El PIN nunca se guarda ni se devuelve al navegador en texto plano.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
