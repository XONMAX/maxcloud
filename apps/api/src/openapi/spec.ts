import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { createRequire } from 'node:module';
import { z } from 'zod';
import * as S from '@maxcloud/shared';

extendZodWithOpenApi(z);
// @maxcloud/shared may resolve its own copy of zod (pnpm symlinks); extend that instance too.
extendZodWithOpenApi(createRequire(require.resolve('@maxcloud/shared'))('zod').z);

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  auth?: 'user' | 'admin' | 'public' | 'payme' | 'stripe';
  body?: z.ZodTypeAny;
  query?: z.AnyZodObject;
  response?: z.ZodTypeAny;
  status?: number;
}

const Ok = z.object({ ok: z.boolean() });
const Url = z.object({ url: z.string().url(), expiresIn: z.number().optional() });
const ErrorBody = z.object({ code: z.string(), message: z.string() }).openapi('Error');
const Node = S.NodeSchema;
const User = S.UserSchema;
const Tokens = z.object({ accessToken: z.string(), refreshToken: z.string(), accessExpiresIn: z.number(), sessionId: z.string() });
const UserResp = z.object({ user: User }).and(Tokens.partial());
const Page = z.object({ items: z.array(Node), nextCursor: z.string().nullable(), role: z.enum(['OWNER', 'EDITOR', 'VIEWER']), breadcrumbs: z.array(z.object({ id: z.string(), name: z.string() })) });
const Upload = S.UploadSessionSchema;
const Link = S.ShareLinkSchema.extend({ url: z.string() });
const Inline = z.object({ inline: z.enum(['0', '1']).optional() });
const NodeQ = z.object({ nodeId: z.string().optional(), parentId: z.string().optional(), inline: z.enum(['0', '1']).optional() });
const PaymeRpc = z.object({ id: z.union([z.number(), z.string()]), method: z.string(), params: z.record(z.unknown()) });
const PaymeResp = z.object({ jsonrpc: z.literal('2.0'), id: z.any(), result: z.record(z.unknown()).optional(), error: z.object({ code: z.number(), message: z.record(z.string()), data: z.string().optional() }).optional() });

/** Single source of truth for documented routes. test/openapi.int.test.ts fails if a Nest route is missing here. */
export const ROUTES: Route[] = [
  // health
  { method: 'get', path: '/health', summary: 'Liveness', tag: 'Ops', auth: 'public', response: Ok },
  { method: 'get', path: '/health/ready', summary: 'Readiness (db, redis, storage)', tag: 'Ops', auth: 'public' },
  { method: 'get', path: '/metrics', summary: 'Prometheus metrics', tag: 'Ops', auth: 'public' },
  // auth
  { method: 'post', path: '/auth/register', summary: 'Create account (sets cookies; native clients send X-Client and get tokens)', tag: 'Auth', auth: 'public', body: S.RegisterSchema, response: UserResp, status: 201 },
  { method: 'post', path: '/auth/login', summary: 'Email + password (+ TOTP when enabled)', tag: 'Auth', auth: 'public', body: S.LoginSchema, response: UserResp },
  { method: 'post', path: '/auth/oauth/{provider}', summary: 'Sign in with a Google or Apple id_token', tag: 'Auth', auth: 'public', body: S.OAuthSchema.extend({ totp: z.string().optional() }), response: UserResp },
  { method: 'post', path: '/auth/refresh', summary: 'Rotate refresh token (reuse revokes the session)', tag: 'Auth', auth: 'public', body: z.object({ refreshToken: z.string().optional() }) },
  { method: 'post', path: '/auth/logout', summary: 'Revoke current session', tag: 'Auth', response: Ok },
  { method: 'get', path: '/auth/me', summary: 'Current user', tag: 'Auth', response: z.object({ user: User }) },
  { method: 'get', path: '/auth/sessions', summary: 'Signed-in devices', tag: 'Auth', response: z.object({ sessions: z.array(S.SessionSchema) }) },
  { method: 'delete', path: '/auth/sessions/{id}', summary: 'Sign out a device', tag: 'Auth', response: Ok },
  { method: 'post', path: '/auth/sessions/revoke-others', summary: 'Sign out all other devices', tag: 'Auth' },
  { method: 'post', path: '/auth/2fa/setup', summary: 'Start TOTP setup (secret + QR)', tag: 'Auth' },
  { method: 'post', path: '/auth/2fa/enable', summary: 'Confirm TOTP, returns recovery codes', tag: 'Auth', body: S.TotpEnableSchema },
  { method: 'post', path: '/auth/2fa/disable', summary: 'Turn off TOTP', tag: 'Auth', body: S.TotpDisableSchema, response: Ok },
  { method: 'post', path: '/auth/password', summary: 'Change password (signs out other devices)', tag: 'Auth', body: S.ChangePasswordSchema, response: Ok },
  { method: 'post', path: '/auth/verify-email', summary: 'Confirm email with token', tag: 'Auth', auth: 'public', body: z.object({ token: z.string() }), response: Ok },
  { method: 'post', path: '/auth/verify-email/resend', summary: 'Resend verification email', tag: 'Auth', response: Ok },
  { method: 'post', path: '/auth/password/forgot', summary: 'Email a reset link', tag: 'Auth', auth: 'public', body: z.object({ email: z.string().email() }), response: Ok },
  { method: 'post', path: '/auth/password/reset', summary: 'Set new password with token', tag: 'Auth', auth: 'public', body: z.object({ token: z.string(), password: z.string() }), response: Ok },
  // files
  { method: 'get', path: '/files', summary: 'List a folder (keyset pagination, folders first)', tag: 'Files', query: S.ListQuerySchema, response: Page },
  { method: 'get', path: '/files/search', summary: 'Search by name and type', tag: 'Files', query: S.SearchQuerySchema, response: z.object({ items: z.array(Node) }) },
  {
    method: 'get',
    path: '/files/tree',
    summary: 'Flat list of all my live items (sync clients)',
    tag: 'Files',
    query: z.object({ cursor: z.string().optional(), limit: z.number().optional() }),
    response: z.object({
      items: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), type: z.enum(['FILE', 'FOLDER']), name: z.string(), size: z.number(), sha256: z.string().nullable(), currentVersionId: z.string().nullable(), updatedAt: z.string() })),
      nextCursor: z.string().nullable(),
    }),
  },
  { method: 'get', path: '/files/shared-with-me', summary: 'Folders shared with me', tag: 'Sharing' },
  { method: 'get', path: '/files/{id}', summary: 'Get one item', tag: 'Files', response: z.object({ node: Node, role: z.string() }) },
  { method: 'post', path: '/folders', summary: 'Create folder', tag: 'Files', body: S.CreateFolderSchema, response: Node, status: 201 },
  { method: 'patch', path: '/files/{id}/name', summary: 'Rename', tag: 'Files', body: S.RenameSchema, response: Node },
  { method: 'patch', path: '/files/{id}/parent', summary: 'Move', tag: 'Files', body: S.MoveSchema, response: Node },
  { method: 'delete', path: '/files/{id}', summary: 'Move to Trash (30-day recovery)', tag: 'Files' },
  { method: 'get', path: '/files/{id}/download', summary: 'Short-lived download/preview URL (direct from storage/CDN)', tag: 'Files', query: Inline, response: Url },
  { method: 'get', path: '/files/{id}/thumbnail', summary: 'Thumbnail URL', tag: 'Files', response: Url },
  { method: 'get', path: '/files/{id}/versions', summary: 'List versions (max 10)', tag: 'Files' },
  { method: 'post', path: '/files/{id}/versions/{versionId}/restore', summary: 'Make a version current', tag: 'Files', response: Node },
  { method: 'delete', path: '/files/{id}/versions/{versionId}', summary: 'Delete an old version', tag: 'Files', response: Ok },
  { method: 'get', path: '/trash', summary: 'Items in Trash', tag: 'Files' },
  { method: 'post', path: '/trash/{id}/restore', summary: 'Restore from Trash', tag: 'Files', response: Node },
  { method: 'delete', path: '/trash/{id}', summary: 'Delete forever', tag: 'Files' },
  { method: 'delete', path: '/trash', summary: 'Empty Trash', tag: 'Files' },
  // uploads
  { method: 'post', path: '/uploads', summary: 'Start resumable upload (reserves quota; may dedupe by sha256)', tag: 'Uploads', body: S.UploadInitSchema, response: Upload, status: 201 },
  { method: 'get', path: '/uploads', summary: 'My pending uploads', tag: 'Uploads' },
  { method: 'get', path: '/uploads/{id}', summary: 'Upload status incl. stored parts (resume)', tag: 'Uploads', response: Upload },
  { method: 'post', path: '/uploads/{id}/parts', summary: 'Presigned PUT URLs for parts', tag: 'Uploads', body: S.UploadPartsSchema, response: z.object({ parts: z.array(z.object({ partNumber: z.number(), url: z.string() })) }) },
  { method: 'post', path: '/uploads/{id}/complete', summary: 'Verify parts in storage and commit', tag: 'Uploads', body: S.UploadCompleteSchema, response: Node },
  { method: 'delete', path: '/uploads/{id}', summary: 'Abort upload, release quota', tag: 'Uploads', response: Ok },
  // sharing
  { method: 'post', path: '/share-links', summary: 'Create public link (password, expiry, view-only)', tag: 'Sharing', body: S.CreateShareLinkSchema, response: Link, status: 201 },
  { method: 'get', path: '/share-links', summary: 'My links (or links for nodeId)', tag: 'Sharing', query: z.object({ nodeId: z.string().optional() }) },
  { method: 'delete', path: '/share-links/{id}', summary: 'Revoke link', tag: 'Sharing', response: Ok },
  { method: 'post', path: '/folders/{id}/shares', summary: 'Share folder with a user (VIEWER/EDITOR)', tag: 'Sharing', body: S.ShareFolderSchema, status: 201 },
  { method: 'get', path: '/folders/{id}/shares', summary: 'People with access', tag: 'Sharing' },
  { method: 'delete', path: '/folders/{id}/shares/{granteeId}', summary: 'Remove access / leave', tag: 'Sharing', response: Ok },
  { method: 'get', path: '/public/shares/{token}', summary: 'Public link metadata', tag: 'Public', auth: 'public' },
  { method: 'post', path: '/public/shares/{token}/unlock', summary: 'Unlock password link (cookie or X-Share-Token)', tag: 'Public', auth: 'public', body: S.UnlockShareSchema },
  { method: 'get', path: '/public/shares/{token}/files', summary: 'Browse shared folder', tag: 'Public', auth: 'public', query: NodeQ },
  { method: 'get', path: '/public/shares/{token}/download', summary: 'Download/preview URL', tag: 'Public', auth: 'public', query: NodeQ, response: Url },
  { method: 'get', path: '/public/shares/{token}/thumbnail', summary: 'Thumbnail URL', tag: 'Public', auth: 'public', query: NodeQ, response: Url },
  { method: 'post', path: '/public/abuse-reports', summary: 'DMCA / abuse report', tag: 'Public', auth: 'public', status: 201 },
  // billing
  { method: 'get', path: '/billing/plans', summary: 'Plans, prices (USD + UZS) and available gateways', tag: 'Billing', auth: 'public' },
  { method: 'get', path: '/billing', summary: 'My plan, subscription and invoices', tag: 'Billing' },
  { method: 'post', path: '/billing/checkout', summary: 'Hosted checkout URL (Stripe / Payme / Click / Uzum)', tag: 'Billing', body: S.CheckoutSchema, response: z.object({ url: z.string(), orderId: z.string().optional() }) },
  { method: 'post', path: '/billing/change-plan', summary: 'Change Stripe plan with proration / cancel at period end', tag: 'Billing', body: S.ChangePlanSchema },
  { method: 'post', path: '/billing/portal', summary: 'Stripe Customer Portal URL', tag: 'Billing', response: z.object({ url: z.string() }) },
  { method: 'get', path: '/billing/invoices/{id}/pdf', summary: 'Invoice PDF', tag: 'Billing' },
  { method: 'post', path: '/billing/webhooks/stripe', summary: 'Stripe webhook (signature verified, idempotent)', tag: 'Webhooks', auth: 'stripe' },
  { method: 'post', path: '/billing/payme', summary: 'Payme Merchant API (JSON-RPC 2.0, Basic auth "Paycom:<key>")', tag: 'Webhooks', auth: 'payme', body: PaymeRpc, response: PaymeResp },
  // account
  { method: 'get', path: '/account/export', summary: 'Download all my data (JSON)', tag: 'Account' },
  { method: 'post', path: '/account/delete', summary: 'Delete account (7-day undo window)', tag: 'Account' },
  { method: 'post', path: '/account/delete/cancel', summary: 'Cancel account deletion', tag: 'Account', response: Ok },
  // admin
  { method: 'get', path: '/admin/overview', summary: 'KPIs, unit economics per tier, COGS alerts', tag: 'Admin', auth: 'admin' },
  { method: 'post', path: '/admin/economics', summary: 'Scenario unit economics', tag: 'Admin', auth: 'admin' },
  { method: 'get', path: '/admin/users', summary: 'Users with usage and storage cost', tag: 'Admin', auth: 'admin' },
  { method: 'post', path: '/admin/users/{id}/quota', summary: 'Manual quota override (audited)', tag: 'Admin', auth: 'admin', body: S.QuotaOverrideSchema, response: Ok },
  { method: 'get', path: '/admin/abuse-reports', summary: 'Abuse/DMCA queue', tag: 'Admin', auth: 'admin' },
  { method: 'post', path: '/admin/abuse-reports/{id}/resolve', summary: 'Action or reject a report', tag: 'Admin', auth: 'admin', response: Ok },
];

export function buildSpec() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registry.registerComponent('securitySchemes', 'cookie', { type: 'apiKey', in: 'cookie', name: 'mc_at' });
  registry.registerComponent('securitySchemes', 'payme', { type: 'http', scheme: 'basic' });
  registry.register('Error', ErrorBody);
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const auth = r.auth ?? 'user';
    registry.registerPath({
      method: r.method,
      path: r.path,
      summary: r.summary,
      tags: [r.tag],
      security: auth === 'user' || auth === 'admin' ? [{ bearer: [] }, { cookie: [] }] : auth === 'payme' ? [{ payme: [] }] : [],
      request: {
        params: params.length ? z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) : undefined,
        query: r.query,
        body: r.body ? { content: { 'application/json': { schema: r.body } } } : undefined,
      },
      responses: {
        [r.status ?? 200]: { description: 'OK', content: r.response ? { 'application/json': { schema: r.response } } : undefined },
        ...(auth === 'public' || auth === 'payme' ? {} : { 401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorBody } } } }),
        400: { description: 'Validation error', content: { 'application/json': { schema: ErrorBody } } },
      },
    });
  }
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'MaxCloud API',
      version: '0.1.0',
      description: 'Consumer cloud storage API. File bytes never pass through this API: uploads and downloads use presigned storage URLs.',
    },
    servers: [{ url: 'https://api.maxcloud.uz' }, { url: 'http://localhost:4000' }],
  });
}
