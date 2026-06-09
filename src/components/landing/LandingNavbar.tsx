import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

export const LandingNavbar = () => {
  const navigate = useNavigate();
  const scrollToEarlyAccess = () => {
    document.getElementById("early-access")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md">
      <div className="container flex h-16 items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">Q</span>
          </div>
          <span className="text-lg font-semibold text-foreground">Quadra</span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("/auth")}
            className="font-medium"
          >
            Iniciar sesión
          </Button>
          <Button
            size="sm"
            onClick={scrollToEarlyAccess}
            className="font-medium"
          >
            Solicitar acceso
          </Button>
        </div>
      </div>
    </header>
  );
};
