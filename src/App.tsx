import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Auth & OAuth — never touch these
import Landing      from "./pages/Landing";
import Auth         from "./pages/Auth";
import MeliCallback from "./pages/MeliCallback";
import NotFound     from "./pages/NotFound";

// New UX — 8 pages
import Pipeline              from "./pages/Pipeline";
import PageVentas            from "./pages/PageVentas";
import PageConciliacion      from "./pages/PageConciliacion";
import ConfigNew             from "./pages/ConfigNew";
import PageDashboard         from "./pages/PageDashboard";
import PageAsistente         from "./pages/PageAsistente";
import PageLiquidaciones     from "./pages/PageLiquidaciones";
import PageDevoluciones      from "./pages/PageDevoluciones";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Entry */}
          <Route path="/"     element={<Landing />} />
          <Route path="/auth" element={<Auth />} />

          {/* App — 7 pages */}
          <Route path="/resumen"      element={<PageDashboard />} />
          <Route path="/ventas"       element={<PageVentas />} />
          <Route path="/documentos"   element={<PageVentas />} />
          <Route path="/conciliacion" element={<PageConciliacion />} />
          <Route path="/liquidaciones" element={<PageLiquidaciones />} />
          <Route path="/devoluciones"  element={<PageDevoluciones />} />
          <Route path="/pipeline"     element={<Pipeline />} />
          <Route path="/asistente"    element={<PageAsistente />} />
          <Route path="/config"       element={<ConfigNew />} />

          {/* OAuth callbacks — DO NOT TOUCH */}
          <Route path="/meli-callback" element={<MeliCallback />} />

          {/* Legacy redirects */}
          <Route path="/dashboard"        element={<Navigate to="/resumen" replace />} />
          <Route path="/sandbox-mp"       element={<Navigate to="/liquidaciones" replace />} />
          <Route path="/mercadolibre"     element={<Navigate to="/ventas" replace />} />
          <Route path="/bsale"            element={<Navigate to="/ventas" replace />} />
          <Route path="/flujo"            element={<Navigate to="/resumen" replace />} />
          <Route path="/sales"            element={<Navigate to="/mercadolibre" replace />} />
          <Route path="/payments"         element={<Navigate to="/pipeline" replace />} />
          <Route path="/payments/:id"     element={<Navigate to="/pipeline" replace />} />
          <Route path="/orders/:id"       element={<Navigate to="/mercadolibre" replace />} />
          <Route path="/bsale-documents"  element={<Navigate to="/bsale" replace />} />
          <Route path="/reports/*"        element={<Navigate to="/pipeline" replace />} />
          <Route path="/pending-sales"    element={<Navigate to="/mercadolibre" replace />} />
          <Route path="/sales/issues"     element={<Navigate to="/mercadolibre" replace />} />
          <Route path="/closing"          element={<Navigate to="/pipeline" replace />} />
          <Route path="/ledger"           element={<Navigate to="/pipeline" replace />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
