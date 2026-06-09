import { Button } from "@/components/ui/button";
import { ArrowRight, Link as LinkIcon } from "lucide-react";
import heroImage from "@/assets/hero-dashboard.jpg";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";

export const HeroSection = () => {
  const navigate = useNavigate();
  const [isLoadingDemo, setIsLoadingDemo] = useState(false);

  const handleDemoLogin = async () => {
    setIsLoadingDemo(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: 'demo@demo.com',
        password: 'demo123456',
      });

      if (error) throw error;

      navigate('/dashboard');
    } catch (error: any) {
      console.error('Error en demo login:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudo acceder a la cuenta demo",
      });
    } finally {
      setIsLoadingDemo(false);
    }
  };
  return (
    <section className="relative min-h-[600px] flex items-center justify-center overflow-hidden">
      <div 
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: `url(${heroImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/90 to-background/80" />
      </div>
      
      <div className="container relative z-10 px-4 md:px-6">
        <div className="max-w-3xl space-y-6">
          <div className="inline-block rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
            Integración Multi-Marketplace
          </div>
          
          <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl lg:text-7xl">
            Gestiona todas tus ventas{" "}
            <span className="text-primary">en un solo lugar</span>
          </h1>
          
          <p className="text-xl text-muted-foreground md:text-2xl">
            Conecta Mercado Libre, Amazon, Shopify, Falabella y más. Administra todas tus ventas desde un dashboard profesional y fácil de usar.
          </p>
          
          <div className="flex flex-col gap-4 sm:flex-row">
            <Button 
              size="lg" 
              className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              onClick={() => window.location.href = '/auth'}
            >
              <LinkIcon className="w-5 h-5" />
              Conectar Marketplaces
              <ArrowRight className="w-4 h-4" />
            </Button>
            <Button 
              size="lg" 
              variant="outline" 
              className="gap-2"
              onClick={handleDemoLogin}
              disabled={isLoadingDemo}
            >
              {isLoadingDemo ? "Cargando..." : "Ver Demo"}
            </Button>
          </div>
          
          <div className="flex items-center gap-8 pt-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-success" />
              <span>Sincronización en tiempo real</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-success" />
              <span>100% seguro</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
