import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// The Pipeline's 5 steps normally run from the browser with the user's own
// JWT. The cron orchestrator (cron-pipeline-sync) has no end-user session, so
// it authenticates with the service-role key instead and passes user_id
// explicitly in the body. Only an exact match on the real service-role key
// is accepted — a body.user_id alone (no matching header) falls through to
// the normal JWT path and fails like any unauthenticated request would.
export async function resolveUserId(
  req: Request,
  client: SupabaseClient,
  bodyUserId?: string | null,
): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (serviceKey && authHeader === `Bearer ${serviceKey}` && bodyUserId) {
    return bodyUserId;
  }

  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}
