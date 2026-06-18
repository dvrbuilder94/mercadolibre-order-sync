import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { 
  Sparkles, Send, Loader2, ArrowRight, BookOpen, 
  HelpCircle, ChevronRight, Calculator, AlertTriangle 
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const PRESETS = [
  {
    icon: AlertTriangle,
    title: "¿Por qué está bloqueado el cierre?",
    description: "Analizar las ventas del periodo que impiden cerrar el mes actual.",
    query: "¿Qué ventas o documentos están bloqueando el cierre del mes actual?"
  },
  {
    icon: Calculator,
    title: "Resumen de Comisiones",
    description: "Ver el desglose de comisiones aproximadas vs reales.",
    query: "Dame un resumen detallado de las comisiones de MercadoLibre y cobros del periodo actual."
  },
  {
    icon: BookOpen,
    title: "Discrepancias de Conciliación",
    description: "Buscar diferencias entre montos de venta y documentos.",
    query: "¿Existen discrepancias entre las órdenes y los documentos tributarios de Bsale?"
  }
];

export default function PageAsistente() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "¡Hola! Soy Quadra AI, tu copiloto financiero para LedgerSync. Puedo ayudarte a auditar tus conciliaciones de MercadoLibre contra Bsale, analizar por qué se bloquea un cierre de mes, o desglosar tus comisiones y costos de envío.\n\n¿En qué te puedo asistir hoy?"
    }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || input).trim();
    if (!text) return;

    if (!textToSend) {
      setInput("");
    }

    const newMessages = [...messages, { role: "user" as const, content: text }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("No hay una sesión activa. Por favor, inicia sesión.");
      }

      // Add placeholder assistant message that we will stream into
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            messages: newMessages.map(m => ({ role: m.role, content: m.content }))
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Error en la llamada al asistente (${response.status})`);
      }

      if (!response.body) {
        throw new Error("No se pudo iniciar la transmisión de respuesta.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        // Process text chunking (SSE protocol formats lines as "data: {text}")
        // Standard AI SDK stream message is directly the raw text in modern stream format, 
        // or standard stream response formats. Let's try parsing or fall back to raw text.
        
        // Split by lines and parse data chunks
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("0:")) { // Text chunk identifier in AI SDK stream protocols
            try {
              const cleaned = JSON.parse(line.slice(2));
              assistantText += cleaned;
            } catch {
              // fallback
              assistantText += line.slice(2);
            }
          } else if (line.startsWith("data:")) {
            // Standard SSE chunk
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              assistantText += parsed;
            } catch {
              assistantText += dataStr;
            }
          } else if (line.trim() && !line.includes(":") && !line.startsWith("{")) {
            // Raw text chunk
            assistantText += line;
          }
        }

        // Update the last message in real-time
        setMessages(prev => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = {
              role: "assistant",
              content: assistantText || "..."
            };
          }
          return updated;
        });
      }

    } catch (err: any) {
      console.error(err);
      toast({
        title: "Error en Asistente AI",
        description: err.message || "No se pudo obtener respuesta.",
        variant: "destructive"
      });
      // Remove the last empty message if there was an error
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="h-16 border-b bg-white flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-emerald-50 rounded-lg text-emerald-600">
              <Sparkles className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-950">Asistente AI</h1>
              <p className="text-[11px] text-slate-400">Copiloto Inteligente para Conciliaciones</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[11px] font-medium text-slate-500">Conectado a Quadra AI</span>
          </div>
        </header>

        {/* Chat / Presets area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.length === 1 && (
              <div className="space-y-6">
                {/* Visual Greeting Hero */}
                <div className="bg-gradient-to-br from-emerald-950 to-slate-900 rounded-2xl p-6 text-white shadow-md relative overflow-hidden">
                  <div className="absolute right-0 bottom-0 translate-x-10 translate-y-10 opacity-10">
                    <Sparkles className="h-48 w-44 text-white" />
                  </div>
                  <div className="relative z-10 space-y-2">
                    <div className="inline-flex items-center gap-1 bg-emerald-800/50 text-emerald-200 text-xs px-2.5 py-1 rounded-full border border-emerald-700">
                      <Sparkles className="h-3 w-3" />
                      Motor de Inteligencia Quadra
                    </div>
                    <h2 className="text-xl font-bold tracking-tight">Optimiza tu contabilidad con Inteligencia Artificial</h2>
                    <p className="text-xs text-emerald-100 max-w-xl leading-relaxed">
                      Este asistente tiene acceso en tiempo real a las transacciones de tu cuenta de MercadoLibre, cuentas de Bsale y cierres del periodo. Pregúntale por boletas faltantes, comisiones estimadas o cómo resolver discrepancias.
                    </p>
                  </div>
                </div>

                {/* Presets Grid */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Preguntas Frecuentes</p>
                  <div className="grid sm:grid-cols-3 gap-3">
                    {PRESETS.map((preset, index) => {
                      const IconComponent = preset.icon;
                      return (
                        <button
                          key={index}
                          onClick={() => handleSend(preset.query)}
                          className="flex flex-col text-left p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm hover:shadow hover:border-emerald-200 transition-all group"
                        >
                          <div className="p-2 bg-slate-50 rounded-lg text-slate-500 group-hover:bg-emerald-50 group-hover:text-emerald-600 transition-all mb-3 self-start">
                            <IconComponent className="h-4 w-4" />
                          </div>
                          <h3 className="text-xs font-bold text-slate-900 mb-1 group-hover:text-emerald-700">{preset.title}</h3>
                          <p className="text-[10px] text-slate-400 leading-relaxed mt-auto">{preset.description}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Chat list */}
            {messages.length > 1 && (
              <div className="space-y-4">
                {messages.map((m, index) => (
                  <div
                    key={index}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`flex gap-3 max-w-[85%] ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                      <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold shadow-sm ${
                        m.role === "user" 
                          ? "bg-slate-900 text-white" 
                          : "bg-emerald-500 text-white"
                      }`}>
                        {m.role === "user" ? "U" : <Sparkles className="h-4 w-4" />}
                      </div>
                      <div className={`rounded-2xl px-4 py-3 text-sm shadow-sm whitespace-pre-wrap leading-relaxed ${
                        m.role === "user"
                          ? "bg-slate-900 text-slate-100 rounded-tr-none"
                          : "bg-white border border-slate-200 text-slate-800 rounded-tl-none"
                      }`}>
                        {m.content}
                      </div>
                    </div>
                  </div>
                ))}
                {isLoading && messages[messages.length - 1].content === "" && (
                  <div className="flex justify-start">
                    <div className="flex gap-3 max-w-[85%] flex-row">
                      <div className="h-8 w-8 rounded-full shrink-0 flex items-center justify-center bg-emerald-500 text-white shadow-sm">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                      <div className="rounded-2xl px-4 py-3 text-sm bg-white border border-slate-200 text-slate-400 rounded-tl-none flex items-center gap-1.5">
                        Pensando...
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t bg-white shrink-0">
          <div className="max-w-3xl mx-auto flex items-center gap-2 relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={isLoading}
              placeholder="Pregúntame sobre tus boletas pendientes, comisiones, o discrepancias de este periodo..."
              className="flex-1 bg-slate-50 text-slate-800 placeholder-slate-400 text-xs px-4 py-3 rounded-full border border-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-50 pr-10"
            />
            <button
              onClick={() => handleSend()}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 p-1.5 bg-slate-900 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-full transition-all"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
