import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

const MeliCallback = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    handleCallback();
  }, []);

  const handleCallback = async () => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    
    if (!code || !state) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se recibió el código de autorización o el token de estado",
      });
      navigate("/settings");
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

      navigate("/dashboard");
    } catch (error: any) {
      console.error('Error in callback:', error);
      toast({
        variant: "destructive",
        title: "Error al autenticar",
        description: error.message,
      });
      navigate("/settings");
    } finally {
      setProcessing(false);
    }
  };

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
