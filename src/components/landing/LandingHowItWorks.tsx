import { Link2, Download, Sparkles, CheckCircle2 } from "lucide-react";

const steps = [
  {
    icon: Link2,
    step: "1",
    title: "Conectas Bsale",
    description: "Solo lectura",
  },
  {
    icon: Download,
    step: "2",
    title: "Importas ventas",
    description: "Del marketplace",
  },
  {
    icon: Sparkles,
    step: "3",
    title: "Conciliación automática",
    description: "Quadra vincula documentos",
  },
  {
    icon: CheckCircle2,
    step: "4",
    title: "Revisión y cierre",
    description: "Del mes",
  },
];

export const LandingHowItWorks = () => {
  return (
    <section className="py-20 md:py-28 bg-muted/30 border-b border-border">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl text-center">
            Cómo funciona
          </h2>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, index) => (
              <div 
                key={index}
                className="relative flex flex-col items-center text-center p-6"
              >
                {/* Connector line for desktop */}
                {index < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-12 left-[60%] w-[80%] h-px bg-border" />
                )}
                
                <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <step.icon className="h-6 w-6" />
                  <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
                    {step.step}
                  </span>
                </div>
                
                <h3 className="mt-4 font-medium text-foreground">
                  {step.title}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
