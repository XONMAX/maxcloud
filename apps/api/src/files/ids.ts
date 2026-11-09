import { randomBytes } from 'node:crypto';

/** Sortable, URL-safe id (time prefix + randomness), same shape class as Prisma cuid ids. */
export function createId(): string {
  return `c${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
}
