export const SCORE_OK = 80;

// match_source values that come from a deterministic ID match (order_id, pack_id,
// webhook). These never carry a meaningful match_score, so "score bajo" checks
// must exclude them — otherwise a hard match with a null/low score field reads
// as "baja confianza" when it's actually the most certain kind of match.
export const HARD_MATCH_SOURCES = new Set([
  "AUTO_HARD_ORDER_ID", "AUTO_HARD_PACK_ID", "AUTO_CONSOLIDATED",
  "webhook_external_order_id", "webhook_fallback_boleta",
]);

export const CHANNEL_LABEL: Record<string, string> = {
  meli: "MercadoLibre", falabella: "Falabella", paris: "Paris",
  ripley: "Ripley", amazon: "Amazon", shopify: "Shopify",
};
export const CHANNEL_COLOR: Record<string, string> = {
  meli: "bg-yellow-100 text-yellow-800", shopify: "bg-blue-100 text-blue-700",
  falabella: "bg-orange-100 text-orange-700", paris: "bg-pink-100 text-pink-700",
  ripley: "bg-purple-100 text-purple-700", amazon: "bg-amber-100 text-amber-800",
};
