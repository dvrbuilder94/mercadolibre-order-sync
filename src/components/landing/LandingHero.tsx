import { Button } from "@/components/ui/button";
import { Shield, Eye } from "lucide-react";

export const LandingHero = () => {
  const scrollToEarlyAccess = () => {
    document.getElementById("early-access")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="relative overflow-hidden bg-[var(--gradient-hero)] pt-24 pb-20 md:pt-32 md:pb-28">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl lg:text-6xl text-balance leading-tight">
            Conciliación automática de ventas y documentos tributarios
          </h1>
          
          <p className="mt-6 text-lg text-muted-foreground md:text-xl max-w-2xl mx-auto">
            Cuadra tus ventas de marketplace con Bsale en minutos, no en días.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4">
            <Button 
              size="lg" 
              onClick={scrollToEarlyAccess}
              className="h-12 px-8 text-base font-medium shadow-lg hover:shadow-xl transition-shadow"
            >
              Solicitar acceso
            </Button>
            
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Shield className="h-4 w-4 text-primary" />
                Integración segura
              </span>
              <span className="text-border">·</span>
              <span className="flex items-center gap-1.5">
                <Eye className="h-4 w-4 text-primary" />
                Solo lectura
              </span>
            </div>
          </div>
        </div>
      </div>
      
      {/* Subtle decorative element */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
      </div>
    </section>
  );
};
