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

// New UX
import Dashboard from "./pages/Dashboard";
import ConfigNew from "./pages/ConfigNew";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Entry */}
          <Route path="/"      element={<Landing />} />
          <Route path="/auth"  element={<Auth />} />

          {/* New UX */}
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/config"    element={<ConfigNew />} />

          {/* OAuth callbacks — DO NOT TOUCH */}
          <Route path="/meli-callback" element={<MeliCallback />} />

          {/* Legacy redirects — keep so old links don't 404 */}
          <Route path="/sales"            element={<Navigate to="/dashboard" replace />} />
          <Route path="/payments"         element={<Navigate to="/dashboard" replace />} />
          <Route path="/payments/:id"     element={<Navigate to="/dashboard" replace />} />
          <Route path="/orders/:id"       element={<Navigate to="/dashboard" replace />} />
          <Route path="/bsale-documents"  element={<Navigate to="/dashboard" replace />} />
          <Route path="/reports/*"        element={<Navigate to="/dashboard" replace />} />
          <Route path="/pending-sales"    element={<Navigate to="/dashboard" replace />} />
          <Route path="/sales/issues"     element={<Navigate to="/dashboard" replace />} />
          <Route path="/closing"          element={<Navigate to="/dashboard" replace />} />
          <Route path="/ledger"           element={<Navigate to="/dashboard" replace />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
