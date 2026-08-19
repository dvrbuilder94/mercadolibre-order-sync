import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Auth & OAuth — never touch these
import Landing      from "./pages/Landing";
import Auth         from "./pages/Auth";
import MeliCallback from "./pages/MeliCallback";
import MercadoPagoCallback from "./pages/MercadoPagoCallback";
import NotFound     from "./pages/NotFound";

// New UX
import Pipeline                  from "./pages/Pipeline";
import PageVentas                from "./pages/PageVentas";
import ConfigNew                 from "./pages/ConfigNew";
import PageTesoreria             from "./pages/PageTesoreria";
import PageTrazabilidadPagosV2   from "./pages/PageTrazabilidadPagosV2";
import PageDevoluciones          from "./pages/PageDevoluciones";
import PageDocumentos            from "./pages/PageDocumentos";
import PageWorkflow              from "./pages/PageWorkflow";
import PageConciliacion          from "./pages/PageConciliacion";
import PageFeedback              from "./pages/PageFeedback";
import PageModeloDatos           from "./pages/PageModeloDatos";
import PageImportMeliBackup      from "./pages/PageImportMeliBackup";

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

          {/* App — Tesorería es el resumen financiero y la puerta de entrada */}
          <Route path="/resumen"      element={<Navigate to="/tesoreria" replace />} />
          <Route path="/ventas"       element={<PageVentas />} />
          <Route path="/documentos"   element={<PageDocumentos />} />
          <Route path="/conciliacion" element={<PageConciliacion />} />
          <Route path="/tesoreria"     element={<PageTesoreria />} />
          <Route path="/trazabilidad"  element={<PageTrazabilidadPagosV2 />} />
          <Route path="/liquidaciones" element={<Navigate to="/tesoreria" replace />} />
          <Route path="/billing"       element={<Navigate to="/tesoreria?tab=cargos" replace />} />
          <Route path="/devoluciones"  element={<PageDevoluciones />} />
          <Route path="/pipeline"     element={<Pipeline />} />
          <Route path="/workflow"     element={<PageWorkflow />} />
          <Route path="/modelo-datos" element={<PageModeloDatos />} />
          <Route path="/arquitectura" element={<Navigate to="/workflow" replace />} />
          <Route path="/asistente"    element={<Navigate to="/tesoreria" replace />} />
          <Route path="/config"       element={<ConfigNew />} />
          <Route path="/admin/import-meli" element={<PageImportMeliBackup />} />
          <Route path="/feedback"     element={<PageFeedback />} />

          {/* OAuth callbacks — DO NOT TOUCH */}
          <Route path="/meli-callback" element={<MeliCallback />} />
          <Route path="/mercadopago/callback" element={<MercadoPagoCallback />} />

          {/* Legacy redirects */}
          <Route path="/dashboard"        element={<Navigate to="/tesoreria" replace />} />
          <Route path="/sandbox-mp"       element={<Navigate to="/tesoreria" replace />} />
          <Route path="/mercadolibre"     element={<Navigate to="/ventas" replace />} />
          <Route path="/bsale"            element={<Navigate to="/ventas" replace />} />
          <Route path="/flujo"            element={<Navigate to="/tesoreria" replace />} />
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
