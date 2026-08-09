import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

// Asistente de conexión con MercadoLibre.
// MercadoLibre exige que cada vendedor cree su propia aplicación en el DevCenter:
// de ahí salen el App ID y la Clave secreta que usamos para el OAuth. Este
// asistente guía ese paso antes de mandar al usuario a autorizar.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MeliConnectWizard({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const redirectUri = `${window.location.origin}/meli-callback`;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    supabase
      .from("meli_accounts")
      .select("client_id")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.client_id) setClientId(data.client_id);
      });
  }, [open]);

  const copy = (value: string) => {
    navigator.clipboard.writeText(value);
    toast.success("Copiado al portapapeles");
  };

  const saveAndAuthorize = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("Ingresa el App ID y la Clave secreta de tu aplicación");
      return;
    }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");

      const { data: existing } = await supabase
        .from("meli_accounts")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const credentials = {
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        redirect_uri: redirectUri,
        site_id: "MLC",
      };

      const { error: saveError } = existing
        ? await supabase.from("meli_accounts").update(credentials).eq("id", existing.id)
        : await supabase.from("meli_accounts").insert({ ...credentials, user_id: user.id });

      if (saveError) throw new Error(saveError.message);

      const { data, error } = await supabase.functions.invoke("get-meli-auth-url");
      if (error) {
        // Los errores de edge functions traen el detalle en el body, no en el mensaje.
        let detail = "";
        try {
          const body = await (error as { context?: Response }).context?.json();
          detail = body?.error ?? "";
        } catch { /* sin body legible */ }
        throw new Error(detail || "No se pudo generar la URL de autorización");
      }
      const authUrl = data?.authUrl || data?.auth_url;
      if (!authUrl) throw new Error(data?.error || "MercadoLibre no devolvió una URL de autorización");
      window.location.assign(authUrl);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "No se pudo conectar MercadoLibre");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Conectar MercadoLibre</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Paso 1 de 2 · Crea tu aplicación en el DevCenter de MercadoLibre"
              : "Paso 2 de 2 · Pega las credenciales de tu aplicación"}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4 text-sm">
            <ol className="space-y-3 list-decimal pl-5 text-muted-foreground">
              <li>
                Entra al DevCenter con la misma cuenta con la que vendes y crea una aplicación
                nueva.
              </li>
              <li>
                En <strong>URIs de redirect</strong> pega exactamente esta dirección:
                <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/50 p-2">
                  <code className="flex-1 break-all text-xs">{redirectUri}</code>
                  <Button size="icon" variant="ghost" onClick={() => copy(redirectUri)} aria-label="Copiar URI de redirect">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </li>
              <li>
                En <strong>Tópicos de notificación</strong> puedes dejar todo sin marcar por ahora.
              </li>
              <li>
                Guarda y copia el <strong>App ID</strong> y la <strong>Clave secreta</strong>.
              </li>
            </ol>

            <a
              href="https://developers.mercadolibre.cl/devcenter/create-app"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              Abrir DevCenter de MercadoLibre <ExternalLink className="h-4 w-4" />
            </a>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button onClick={() => setStep(2)}>Ya creé mi aplicación</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meli-client-id">App ID</Label>
              <Input
                id="meli-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1234567890123456"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meli-client-secret">Clave secreta</Label>
              <Input
                id="meli-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="••••••••••••••••"
                autoComplete="off"
              />
            </div>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              Las credenciales quedan guardadas solo en tu cuenta y se usan únicamente para
              autorizar el acceso a tus ventas.
            </p>

            <div className="flex justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={saving}>Volver</Button>
              <Button onClick={saveAndAuthorize} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Autorizar en MercadoLibre
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}