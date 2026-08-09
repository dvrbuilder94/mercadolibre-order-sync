import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

// Pantalla de retorno del OAuth de Mercado Pago. El canje de código ya ocurrió
// en el backend; aquí solo confirmamos el resultado y volvemos a Conexiones.
export default function MercadoPagoCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get("status");
  const message = params.get("message");
  const nickname = params.get("nickname");
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (status !== "success") return;
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    const redirect = setTimeout(() => navigate("/config"), 3000);
    return () => { clearInterval(timer); clearTimeout(redirect); };
  }, [status, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border bg-white p-8 text-center">
        {status === "success" ? (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <h1 className="mt-4 text-lg font-semibold">Mercado Pago conectado</h1>
            <p className="mt-1 text-sm text-slate-500">
              {nickname ? `Cuenta ${nickname} autorizada.` : "Cuenta autorizada."} Ya podemos leer
              tus pagos, comisiones y liquidaciones.
            </p>
            <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Volviendo a Conexiones en {countdown}s
            </p>
          </>
        ) : (
          <>
            <XCircle className="mx-auto h-10 w-10 text-red-500" />
            <h1 className="mt-4 text-lg font-semibold">No se pudo conectar</h1>
            <p className="mt-1 text-sm text-slate-500">
              {message || "La autorización con Mercado Pago no se completó."}
            </p>
            <button
              onClick={() => navigate("/config")}
              className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700"
            >
              Volver a Conexiones
            </button>
          </>
        )}
      </div>
    </div>
  );
}
