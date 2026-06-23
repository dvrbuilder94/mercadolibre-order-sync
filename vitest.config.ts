import { defineConfig } from "vitest/config";
import path from "path";

// Tests de lógica de negocio pura (sin DOM). El alias @ replica el de vite.config
// para que los imports "@/lib/..." funcionen igual que en la app.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
