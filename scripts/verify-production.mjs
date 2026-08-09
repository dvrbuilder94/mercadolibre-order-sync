const baseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const cronSecret = process.env.CRON_SECRET || "";

if (!baseUrl) {
  console.error("Set SUPABASE_URL=https://<project-ref>.supabase.co");
  process.exit(2);
}

const checks = [
  { name: "pipeline cron rejects GET", endpoint: "cron-pipeline-sync", method: "GET", expected: 405 },
  { name: "pipeline cron rejects anonymous POST", endpoint: "cron-pipeline-sync", method: "POST", body: {}, expected: 401 },
  { name: "token cron rejects GET", endpoint: "cron-refresh-meli-tokens", method: "GET", expected: 405 },
  { name: "token cron rejects anonymous POST", endpoint: "cron-refresh-meli-tokens", method: "POST", body: {}, expected: 401 },
  { name: "MELI webhook rejects GET", endpoint: "meli-webhook", method: "GET", expected: 405 },
  {
    name: "MELI webhook validates payload",
    endpoint: "meli-webhook",
    method: "POST",
    body: { topic: "orders_v2", resource: "invalid", user_id: "invalid" },
    expected: 400,
  },
  { name: "Bsale webhook rejects GET", endpoint: "bsale-webhook", method: "GET", expected: 405 },
  { name: "Bsale webhook validates payload", endpoint: "bsale-webhook", method: "POST", body: {}, expected: 400 },
];

if (cronSecret) {
  checks.push(
    {
      name: "pipeline cron accepts configured secret",
      endpoint: "cron-pipeline-sync",
      method: "POST",
      body: {},
      expected: 200,
      headers: { "x-cron-secret": cronSecret },
    },
    {
      name: "token cron accepts configured secret",
      endpoint: "cron-refresh-meli-tokens",
      method: "POST",
      body: {},
      expected: 200,
      headers: { "x-cron-secret": cronSecret },
    },
  );
}

let failed = 0;
for (const check of checks) {
  try {
    const response = await fetch(`${baseUrl}/functions/v1/${check.endpoint}`, {
      method: check.method,
      headers: {
        ...(check.body ? { "Content-Type": "application/json" } : {}),
        ...(check.headers || {}),
      },
      body: check.body ? JSON.stringify(check.body) : undefined,
      signal: AbortSignal.timeout(130_000),
    });
    const ok = response.status === check.expected;
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}: HTTP ${response.status} (expected ${check.expected})`);
    if (!ok) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!cronSecret) {
  console.log("SKIP authenticated cron execution: set CRON_SECRET to test it.");
}

process.exitCode = failed ? 1 : 0;

