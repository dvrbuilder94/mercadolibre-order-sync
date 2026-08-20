import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function hasValidRunnerVaultSecret(req: Request): Promise<boolean> {
  const supplied = req.headers.get('x-sync-runner-secret') ?? '';
  if (!supplied) return false;

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) return false;

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await admin.rpc('verify_sync_runner_secret', { p_secret: supplied });
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * Internal functions are never anonymously callable.
 *
 * Supported authentication paths:
 * - service-role bearer token
 * - existing CRON_SECRET in x-cron-secret (legacy/schedulers)
 * - database-generated Sync runner secret in x-sync-runner-secret
 *
 * The third path lets pg_net authenticate sync-runner without rotating or
 * exposing the CRON_SECRET used by other scheduled functions.
 */
export async function isInternalRequest(req: Request): Promise<boolean> {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const authorization = req.headers.get('authorization') ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const suppliedCronSecret = req.headers.get('x-cron-secret') ?? '';

  if (serviceRoleKey !== '' && await sameSecret(bearer, serviceRoleKey)) return true;
  if (cronSecret !== '' && await sameSecret(suppliedCronSecret, cronSecret)) return true;
  return hasValidRunnerVaultSecret(req);
}

export function unauthorizedJson(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
