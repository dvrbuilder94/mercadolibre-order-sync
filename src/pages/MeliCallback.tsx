import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

const MeliCallback = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [processing, setProcessing] = useState(true);
  const startedRef = useRef(false);

  const handleCallback = useCallback(async () => {
    // El código de autorización de MercadoLibre es de un solo uso: evitamos
    // el doble disparo del efecto en modo estricto de React.
    if (startedRef.current) return;
    startedRef.current = true;

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    
    if (!code || !state) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se recibió el código de autorización o el token de estado",
      });
      navigate("/config");
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('meli-callback', {
        body: { code, state },
      });

      if (error) throw error;

      toast({
        title: "¡Cuenta conectada!",
        description: "Tu cuenta de Mercado Libre ha sido autenticada correctamente.",
      });

      navigate("/config");
    } catch (error: unknown) {
      console.error('Error in callback:', error);
      toast({
        variant: "destructive",
        title: "Error al autenticar",
        description: error instanceof Error ? error.message : "No se pudo completar la autenticación",
      });
      navigate("/config");
    } finally {
      setProcessing(false);
    }
  }, [navigate, searchParams]);

  useEffect(() => {
    void handleCallback();
  }, [handleCallback]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background">
      <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
      <p className="text-lg font-medium">Procesando autenticación...</p>
      <p className="text-sm text-muted-foreground mt-2">
        Esto puede tomar unos segundos
      </p>
    </div>
  );
};

export default MeliCallback;
