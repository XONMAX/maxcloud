import { Injectable } from '@nestjs/common';
import type { Node } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';

export type Role = 'OWNER' | 'EDITOR' | 'VIEWER';
const RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

/**
 * Who may do what with a node. Owners have full access; shared-folder grants
 * (FolderShare) apply to the folder and everything below it. Unknown and
 * forbidden nodes both return 404 so we never leak existence.
 */
@Injectable()
export class AccessService {
  constructor(private prisma: PrismaService) {}

  /** Highest role the user holds via shares on the node or any ancestor. */
  async sharedRole(userId: string, nodeId: string): Promise<Role | null> {
    const rows = await this.prisma.$queryRaw<{ role: 'VIEWER' | 'EDITOR' }[]>`
      WITH RECURSIVE anc AS (
        SELECT id, "parentId", 0 AS depth FROM "Node" WHERE id = ${nodeId}
        UNION ALL
        SELECT n.id, n."parentId", a.depth + 1 FROM "Node" n JOIN anc a ON n.id = a."parentId" WHERE a.depth < 100
      )
      SELECT fs.role FROM "FolderShare" fs JOIN anc ON fs."nodeId" = anc.id WHERE fs."granteeId" = ${userId}`;
    if (!rows.length) return null;
    return rows.some((r) => r.role === 'EDITOR') ? 'EDITOR' : 'VIEWER';
  }

  async resolve(userId: string, nodeId: string, need: Role, opts: { allowDeleted?: boolean } = {}): Promise<{ node: Node; role: Role }> {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!node || (node.deletedAt && !opts.allowDeleted)) throw Errors.notFound('File');
    const role: Role | null = node.ownerId === userId ? 'OWNER' : node.deletedAt ? null : await this.sharedRole(userId, nodeId);
    if (!role) throw Errors.notFound('File');
    if (RANK[role] < RANK[need]) throw Errors.forbidden(need === 'OWNER' ? 'Only the owner can do this' : 'You have view-only access');
    return { node, role };
  }

  /** Is `nodeId` equal to or inside `ancestorId`? */
  async isWithin(nodeId: string, ancestorId: string): Promise<boolean> {
    if (nodeId === ancestorId) return true;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE anc AS (
        SELECT id, "parentId", 0 AS depth FROM "Node" WHERE id = ${nodeId}
        UNION ALL
        SELECT n.id, n."parentId", a.depth + 1 FROM "Node" n JOIN anc a ON n.id = a."parentId" WHERE a.depth < 100
      )
      SELECT id FROM anc WHERE id = ${ancestorId} LIMIT 1`;
    return rows.length > 0;
  }

  /** Ancestor chain root -> node (inclusive), for breadcrumbs. */
  async path(nodeId: string): Promise<{ id: string; name: string; ownerId: string }[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; ownerId: string; depth: number }[]>`
      WITH RECURSIVE anc AS (
        SELECT id, name, "ownerId", "parentId", 0 AS depth FROM "Node" WHERE id = ${nodeId}
        UNION ALL
        SELECT n.id, n.name, n."ownerId", n."parentId", a.depth + 1 FROM "Node" n JOIN anc a ON n.id = a."parentId" WHERE a.depth < 100
      )
      SELECT id, name, "ownerId", depth FROM anc ORDER BY depth DESC`;
    return rows.map(({ id, name, ownerId }) => ({ id, name, ownerId }));
  }
}
