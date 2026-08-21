import type { SupabaseClient, User } from 'https://esm.sh/@supabase/supabase-js@2';

export type OrgAdminContext = {
  user: User;
  organizationId: string;
  ownerUserId: string;
  role: 'owner' | 'admin';
};

export async function requireOrgAdmin(
  admin: SupabaseClient,
  authHeader: string | null,
): Promise<OrgAdminContext> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');

  const token = authHeader.slice('Bearer '.length);
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) throw new Error('UNAUTHORIZED');

  const { data: membership, error: membershipError } = await admin
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) throw new Error('ORG_NOT_FOUND');
  if (!['owner', 'admin'].includes(String(membership.role))) throw new Error('FORBIDDEN');

  const { data: organization, error: orgError } = await admin
    .from('organizations')
    .select('id, owner_user_id')
    .eq('id', membership.organization_id)
    .single();

  if (orgError || !organization?.owner_user_id) throw new Error('ORG_NOT_FOUND');

  return {
    user,
    organizationId: String(organization.id),
    ownerUserId: String(organization.owner_user_id),
    role: String(membership.role) as 'owner' | 'admin',
  };
}

export function orgAdminErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'UNAUTHORIZED') return 401;
  if (message === 'FORBIDDEN') return 403;
  if (message === 'ORG_NOT_FOUND') return 404;
  return 500;
}
