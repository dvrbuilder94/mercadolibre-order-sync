export const LandingFooter = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="py-12 border-t border-border">
      <div className="container px-4 md:px-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <span className="text-sm font-bold text-primary-foreground">Q</span>
            </div>
            <span className="text-lg font-semibold text-foreground">Quadra</span>
          </div>
          
          <p className="text-sm text-muted-foreground">
            Fintech para conciliación contable
          </p>
          
          <p className="text-xs text-muted-foreground">
            © {currentYear} Quadra. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </footer>
  );
};
