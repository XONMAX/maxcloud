import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { uploadFile } from './upload-helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('public share links', () => {
  it('file link without password: meta + download, counts downloads', async () => {
    const u = await registerUser(ctx, 'sharer');
    const f = await uploadFile(ctx, u, 'menu.pdf', Buffer.from('%PDF-1.4 hello'), null, { mimeType: 'application/pdf' });
    const link = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id }).expect(201);
    expect(link.body.url).toMatch(/\/s\/[\w-]{20,}$/);
    const meta = await ctx.http().get(`/public/shares/${link.body.token}`).expect(200);
    expect(meta.body).toMatchObject({ unlocked: true, requiresPassword: false, node: { name: 'menu.pdf' } });
    const dl = await ctx.http().get(`/public/shares/${link.body.token}/download`).expect(200);
    expect(await (await fetch(dl.body.url)).text()).toBe('%PDF-1.4 hello');
    const links = await u.auth(ctx.http().get(`/share-links?nodeId=${f.body.id}`)).expect(200);
    expect(links.body.items[0].downloadCount).toBe(1);
  });

  it('password-protected folder link: locked until unlocked, browse only inside the shared folder', async () => {
    const u = await registerUser(ctx, 'pw');
    const outside = await uploadFile(ctx, u, 'secret.txt', Buffer.from('nope'));
    const folder = (await u.auth(ctx.http().post('/folders')).send({ name: 'Wedding' }).expect(201)).body;
    const sub = (await u.auth(ctx.http().post('/folders')).send({ name: 'Day 1', parentId: folder.id }).expect(201)).body;
    const pic = await uploadFile(ctx, u, 'a.jpg', Buffer.from('jpg'), sub.id, { mimeType: 'image/jpeg' });
    const link = await u.auth(ctx.http().post('/share-links')).send({ nodeId: folder.id, password: 'toy-2026' }).expect(201);
    const t = link.body.token;

    const locked = await ctx.http().get(`/public/shares/${t}`).expect(200);
    expect(locked.body).toEqual({ requiresPassword: true, unlocked: false });
    expect((await ctx.http().get(`/public/shares/${t}/files`).expect(401)).body.code).toBe('PASSWORD_REQUIRED');
    await ctx.http().post(`/public/shares/${t}/unlock`).send({ password: 'wrong' }).expect(401);
    const un = await ctx.http().post(`/public/shares/${t}/unlock`).send({ password: 'toy-2026' }).expect(200);
    const st = un.body.shareToken as string;

    const root = await ctx.http().get(`/public/shares/${t}/files`).set('X-Share-Token', st).expect(200);
    expect(root.body.items.map((n: { name: string }) => n.name)).toEqual(['Day 1']);
    const day1 = await ctx.http().get(`/public/shares/${t}/files?parentId=${sub.id}`).set('X-Share-Token', st).expect(200);
    expect(day1.body.breadcrumbs.map((b: { name: string }) => b.name)).toEqual(['Wedding', 'Day 1']);
    await ctx.http().get(`/public/shares/${t}/download?nodeId=${pic.body.id}`).set('X-Share-Token', st).expect(200);
    // cannot escape the shared folder
    await ctx.http().get(`/public/shares/${t}/download?nodeId=${outside.body.id}`).set('X-Share-Token', st).expect(404);
    // cookie flow works too
    const cookie = (un.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`mc_share_${t}=`))!;
    await ctx.http().get(`/public/shares/${t}/files`).set('Cookie', cookie.split(';')[0]).expect(200);
  });

  it('expired, revoked and view-only links', async () => {
    const u = await registerUser(ctx, 'exp');
    const f = await uploadFile(ctx, u, 'x.jpg', Buffer.from('x'), null, { mimeType: 'image/jpeg' });
    await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id, expiresAt: new Date(Date.now() - 1000).toISOString() }).expect(400);
    const l = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id, expiresAt: new Date(Date.now() + 60_000).toISOString(), allowDownload: false }).expect(201);
    expect((await ctx.http().get(`/public/shares/${l.body.token}/download`).expect(403)).body.message).toMatch(/disabled downloads/);
    await ctx.http().get(`/public/shares/${l.body.token}/download?inline=1`).expect(200); // preview allowed
    await ctx.prisma.shareLink.update({ where: { id: l.body.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await ctx.http().get(`/public/shares/${l.body.token}`).expect(410)).body.code).toBe('LINK_EXPIRED');

    const l2 = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id }).expect(201);
    await u.auth(ctx.http().delete(`/share-links/${l2.body.id}`)).expect(200);
    await ctx.http().get(`/public/shares/${l2.body.token}`).expect(404);
  });

  it('links die with the file when it goes to Trash', async () => {
    const u = await registerUser(ctx, 'die');
    const f = await uploadFile(ctx, u, 'gone.txt', Buffer.from('x'));
    const l = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id }).expect(201);
    await u.auth(ctx.http().delete(`/files/${f.body.id}`)).expect(200);
    await ctx.http().get(`/public/shares/${l.body.token}`).expect(404);
  });
});

describe('shared folders between users', () => {
  it('viewer can browse and download but not modify; editor uploads count against the owner', async () => {
    const owner = await registerUser(ctx, 'owner');
    const viewer = await registerUser(ctx, 'viewer');
    const editor = await registerUser(ctx, 'editor');
    const stranger = await registerUser(ctx, 'stranger');
    const fam = (await owner.auth(ctx.http().post('/folders')).send({ name: 'Family' }).expect(201)).body;
    const doc = await uploadFile(ctx, owner, 'passport.jpg', Buffer.alloc(100), fam.id, { mimeType: 'image/jpeg' });

    await owner.auth(ctx.http().post(`/folders/${fam.id}/shares`)).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    await owner.auth(ctx.http().post(`/folders/${fam.id}/shares`)).send({ email: editor.email, role: 'EDITOR' }).expect(201);
    await owner.auth(ctx.http().post(`/folders/${fam.id}/shares`)).send({ email: 'nobody@nowhere.uz', role: 'VIEWER' }).expect(404);

    const swm = await viewer.auth(ctx.http().get('/files/shared-with-me')).expect(200);
    expect(swm.body.items[0]).toMatchObject({ name: 'Family', role: 'VIEWER' });
    await viewer.auth(ctx.http().get(`/files?parentId=${fam.id}`)).expect(200);
    await viewer.auth(ctx.http().get(`/files/${doc.body.id}/download`)).expect(200);
    await viewer.auth(ctx.http().delete(`/files/${doc.body.id}`)).expect(403);
    expect((await uploadFile(ctx, viewer, 'v.txt', Buffer.from('v'), fam.id)).status).toBe(403);

    await stranger.auth(ctx.http().get(`/files?parentId=${fam.id}`)).expect(404);
    await stranger.auth(ctx.http().get(`/files/${doc.body.id}/download`)).expect(404);

    const up = await uploadFile(ctx, editor, 'from-editor.txt', Buffer.alloc(50), fam.id);
    expect(up.status).toBe(200);
    expect(up.body.ownerId).toBe(owner.user.id);
    const o = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const e = await ctx.prisma.user.findUniqueOrThrow({ where: { id: editor.user.id } });
    expect(Number(o.usedBytes)).toBe(150);
    expect(Number(e.usedBytes)).toBe(0);

    // editor can't move things into their own storage (would dodge the owner's quota)
    await editor.auth(ctx.http().patch(`/files/${up.body.id}/parent`)).send({ parentId: null }).expect(403);

    // grantee leaves
    await viewer.auth(ctx.http().delete(`/folders/${fam.id}/shares/${viewer.user.id}`)).expect(200);
    await viewer.auth(ctx.http().get(`/files?parentId=${fam.id}`)).expect(404);
  });
});
