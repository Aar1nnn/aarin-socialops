export const PREFERRED_DEFAULT_CLIENT_SLUG = "demo-furniture-export";

type MembershipCandidate = {
  client: {
    id: string;
    slug: string;
    isDemo: boolean;
    createdAt: Date;
  };
};

export function selectDefaultMembership<T extends MembershipCandidate>(memberships: readonly T[]): T | undefined {
  const ordered = [...memberships].sort((left, right) => {
    const createdAtDifference = left.client.createdAt.getTime() - right.client.createdAt.getTime();
    if (createdAtDifference !== 0) return createdAtDifference;
    if (left.client.slug !== right.client.slug) return left.client.slug < right.client.slug ? -1 : 1;
    if (left.client.id === right.client.id) return 0;
    return left.client.id < right.client.id ? -1 : 1;
  });

  return ordered.find((item) => item.client.slug === PREFERRED_DEFAULT_CLIENT_SLUG)
    ?? ordered.find((item) => item.client.isDemo)
    ?? ordered[0];
}
