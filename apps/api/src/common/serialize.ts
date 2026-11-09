import type { Node, User } from '@prisma/client';
import type { NodeDto, UserDto } from '@maxcloud/shared';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    totpEnabled: !!u.totpEnabledAt,
    emailVerified: !!u.emailVerifiedAt,
    planId: u.planId,
    quotaBytes: Number(u.quotaBytes),
    usedBytes: Number(u.usedBytes),
    reservedBytes: Number(u.reservedBytes),
    storageState: u.storageState,
    graceEndsAt: iso(u.graceEndsAt),
    deletionScheduledAt: iso(u.deletionScheduledAt),
    locale: u.locale,
  };
}

export function toNodeDto(n: Node): NodeDto {
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    parentId: n.parentId,
    size: Number(n.size),
    mimeType: n.mimeType,
    kind: n.kind,
    hasThumbnail: n.hasThumbnail,
    versionCount: n.versionCount,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    deletedAt: iso(n.deletedAt),
    ownerId: n.ownerId,
  };
}
