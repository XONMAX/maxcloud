/**
 * Request/response contracts shared by API (validation), web (forms) and the
 * OpenAPI generator. Keep these the only definition of each payload.
 */
import { z } from 'zod';

const password = z.string().min(10, 'At least 10 characters').max(200);
const email = z.string().trim().toLowerCase().email().max(254);
const id = z.string().min(1).max(64);
const fileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[\/\\\0]/.test(n) && n !== '.' && n !== '..', 'Invalid name');

// ---------- Auth ----------
export const RegisterSchema = z.object({ email, password, name: z.string().trim().min(1).max(100), locale: z.enum(['uz', 'ru', 'en']).default('uz') });
export const LoginSchema = z.object({ email, password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$|^[a-z0-9]{10}$/i).optional() });
export const OAuthSchema = z.object({ idToken: z.string().min(20), name: z.string().max(100).optional() });
export const TotpEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const TotpDisableSchema = z.object({ password: z.string().min(1), code: z.string().min(6).max(10) });
export const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['USER', 'ADMIN']),
  totpEnabled: z.boolean(),
  emailVerified: z.boolean(),
  planId: z.string(),
  quotaBytes: z.number(),
  usedBytes: z.number(),
  reservedBytes: z.number(),
  storageState: z.enum(['ACTIVE', 'GRACE', 'READ_ONLY', 'PENDING_DELETION']),
  graceEndsAt: z.string().nullable(),
  deletionScheduledAt: z.string().nullable(),
  locale: z.string(),
});
export type UserDto = z.infer<typeof UserSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  deviceName: z.string(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean(),
});
export type SessionDto = z.infer<typeof SessionSchema>;

// ---------- Files ----------
export const CreateFolderSchema = z.object({ name: fileName, parentId: id.nullable().default(null) });
export const RenameSchema = z.object({ name: fileName });
export const MoveSchema = z.object({ parentId: id.nullable() });
export const ListQuerySchema = z.object({
  parentId: id.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  sort: z.enum(['name', 'updatedAt', 'size']).default('name'),
});
export const SearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  kind: z.enum(['image', 'video', 'audio', 'pdf', 'document', 'archive', 'text', 'other']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const NodeSchema = z.object({
  id: z.string(),
  type: z.enum(['FILE', 'FOLDER']),
  name: z.string(),
  parentId: z.string().nullable(),
  size: z.number(),
  mimeType: z.string().nullable(),
  kind: z.string().nullable(),
  hasThumbnail: z.boolean(),
  versionCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  ownerId: z.string(),
});
export type NodeDto = z.infer<typeof NodeSchema>;

export const UploadInitSchema = z.object({
  name: fileName,
  parentId: id.nullable().default(null),
  size: z.number().int().min(0).max(5 * 1024 ** 4),
  mimeType: z.string().max(200).default('application/octet-stream'),
  /** Optional hex sha256 of the whole file for dedupe (mobile auto-backup). */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const UploadPartsSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100) });
export const UploadCompleteSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(200) })).min(1).max(10000),
});

export const UploadSessionSchema = z.object({
  uploadId: z.string(),
  partSize: z.number(),
  partCount: z.number(),
  expiresAt: z.string(),
  /** Parts already stored (for resume). */
  completedParts: z.array(z.object({ partNumber: z.number(), etag: z.string(), size: z.number() })),
  /** Set when the upload was satisfied by dedupe and no bytes need to be sent. */
  deduplicatedNode: NodeSchema.nullable(),
});
export type UploadSessionDto = z.infer<typeof UploadSessionSchema>;

// ---------- Sharing ----------
export const CreateShareLinkSchema = z.object({
  nodeId: id,
  password: z.string().min(4).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  allowDownload: z.boolean().default(true),
});
export const ShareLinkSchema = z.object({
  id: z.string(),
  token: z.string(),
  nodeId: z.string(),
  hasPassword: z.boolean(),
  expiresAt: z.string().nullable(),
  allowDownload: z.boolean(),
  createdAt: z.string(),
  downloadCount: z.number(),
});
export const UnlockShareSchema = z.object({ password: z.string().min(1).max(200) });
export const ShareFolderSchema = z.object({ email, role: z.enum(['VIEWER', 'EDITOR']) });

// ---------- Billing ----------
export const CheckoutSchema = z.object({
  planId: z.enum(['s50', 's100', 's250', 's500', 's1000']),
  interval: z.enum(['month', 'year']),
  provider: z.enum(['stripe', 'payme', 'click', 'uzum']),
});
export const ChangePlanSchema = z.object({ planId: z.enum(['free', 's50', 's100', 's250', 's500', 's1000']), interval: z.enum(['month', 'year']) });

// ---------- Admin ----------
export const QuotaOverrideSchema = z.object({ quotaBytes: z.number().int().min(0).nullable(), reason: z.string().min(3).max(500) });
