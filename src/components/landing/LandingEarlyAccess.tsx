import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const LandingEarlyAccess = () => {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      toast.error("Por favor ingresa tu email");
      return;
    }

    setIsLoading(true);
    try {
      const { error } = await (supabase as any)
        .from("early_access_leads")
        .insert({ email: normalizedEmail, source: "landing" });

      // A repeated request is already safely persisted, so keep the public
      // response idempotent and avoid revealing whether an address exists.
      if (error && error.code !== "23505") throw error;

      toast.success("¡Gracias! Te contactaremos pronto.");
      setEmail("");
    } catch {
      toast.error("No pudimos guardar tu solicitud. Intenta nuevamente.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section id="early-access" className="py-20 md:py-28 bg-primary/5">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl">
            Acceso anticipado
          </h2>
          
          <p className="mt-4 text-muted-foreground">
            Estamos lanzando la primera versión de Quadra. 
            Únete al piloto y sé de los primeros en probarlo.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-2">
            <Input
              type="email"
              name="email"
              autoComplete="email"
              placeholder="tu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 flex-1 bg-background"
              disabled={isLoading}
            />
            <Button 
              type="submit" 
              size="lg"
              className="h-12 px-8 font-medium"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Enviando...
                </>
              ) : (
                "Unirme al piloto"
              )}
            </Button>
          </form>

          <p className="mt-4 text-xs text-muted-foreground">
            Sin spam. Solo actualizaciones importantes sobre Quadra.
          </p>
        </div>
      </div>
    </section>
  );
};
