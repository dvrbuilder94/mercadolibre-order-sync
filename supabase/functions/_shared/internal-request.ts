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

/**
 * Cron functions run with service_role and must never be callable anonymously.
 * A scheduler may authenticate with either the service-role bearer token or a
 * dedicated CRON_SECRET sent in x-cron-secret.
 */
export async function isInternalRequest(req: Request): Promise<boolean> {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const authorization = req.headers.get('authorization') ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const suppliedCronSecret = req.headers.get('x-cron-secret') ?? '';

  return (
    (serviceRoleKey !== '' && await sameSecret(bearer, serviceRoleKey)) ||
    (cronSecret !== '' && await sameSecret(suppliedCronSecret, cronSecret))
  );
}

export function unauthorizedJson(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
