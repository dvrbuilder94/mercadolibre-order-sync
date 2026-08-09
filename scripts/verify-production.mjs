const baseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const cronSecret = process.env.CRON_SECRET || "";
const runCron = process.env.RUN_CRON === "1";

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

if (cronSecret && runCron) {
  checks.push(
    {
      name: "pipeline cron accepts configured secret",
      endpoint: "cron-pipeline-sync",
      method: "POST",
      body: {},
      expected: 200,
      headers: { "x-cron-secret": cronSecret },
      validateJson: (body) => body?.success === true,
    },
    {
      name: "token cron accepts configured secret",
      endpoint: "cron-refresh-meli-tokens",
      method: "POST",
      body: {},
      expected: 200,
      headers: { "x-cron-secret": cronSecret },
      validateJson: (body) => body?.success === true,
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
    const responseText = await response.text();
    let responseJson = null;
    if (responseText) {
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // Some method-rejection responses intentionally have no JSON body.
      }
    }

    const statusOk = response.status === check.expected;
    const bodyOk = !check.validateJson || check.validateJson(responseJson);
    const ok = statusOk && bodyOk;
    const bodyDetail = statusOk && !bodyOk
      ? `; response=${JSON.stringify(responseJson)}`
      : "";
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}: HTTP ${response.status} (expected ${check.expected})${bodyDetail}`);
    if (!ok) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!cronSecret || !runCron) {
  console.log("SKIP authenticated cron execution: set CRON_SECRET and RUN_CRON=1 to run the real jobs.");
}

process.exitCode = failed ? 1 : 0;
