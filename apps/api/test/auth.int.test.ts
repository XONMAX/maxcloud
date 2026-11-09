import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { createTestApp, registerUser, uniqueEmail, type TestCtx } from './helpers';
import { OAuthService } from '../src/auth/oauth.service';
import { MailService } from '../src/mail/mail.service';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

describe('auth: email + password', () => {
  it('registers, gets free plan quota, and reads /auth/me', async () => {
    const u = await registerUser(ctx, 'reg');
    expect(u.user.planId).toBe('free');
    expect(u.user.quotaBytes).toBe(5 * 1024 ** 3);
    const me = await u.auth(ctx.http().get('/auth/me')).expect(200);
    expect(me.body.user.email).toBe(u.email);
  });

  it('rejects duplicate email and weak passwords', async () => {
    const u = await registerUser(ctx, 'dup');
    await ctx.http().post('/auth/register').send({ email: u.email, password: 'another long pw', name: 'x' }).expect(409);
    const weak = await ctx.http().post('/auth/register').send({ email: uniqueEmail(), password: 'short', name: 'x' }).expect(400);
    expect(weak.body.code).toBe('VALIDATION');
  });

  it('login fails with wrong password using a generic error', async () => {
    const u = await registerUser(ctx, 'wrongpw');
    const r = await ctx.http().post('/auth/login').send({ email: u.email, password: 'nope nope nope' }).expect(401);
    expect(r.body.code).toBe('INVALID_CREDENTIALS');
    const r2 = await ctx.http().post('/auth/login').send({ email: uniqueEmail('ghost'), password: 'nope nope nope' }).expect(401);
    expect(r2.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('web cookie flow: login sets httpOnly cookies, CSRF origin check enforced', async () => {
    const u = await registerUser(ctx, 'cookie');
    const login = await ctx.http().post('/auth/login').send({ email: u.email, password: u.password }).expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('mc_at=') && c.includes('HttpOnly'))).toBe(true);
    expect(login.body.accessToken).toBeUndefined(); // never exposed to JS on the web
    await ctx.http().get('/auth/me').set('Cookie', cookies).expect(200);
    // mutating request with cookie but foreign Origin -> blocked
    const bad = await ctx.http().post('/auth/logout').set('Cookie', cookies).set('Origin', 'https://evil.example').expect(403);
    expect(bad.body.code).toBe('BAD_ORIGIN');
    await ctx.http().post('/auth/logout').set('Cookie', cookies).set('Origin', 'http://localhost:3000').expect(200);
  });
});

describe('auth: sessions & refresh rotation', () => {
  it('refresh rotates the token and detects reuse', async () => {
    const u = await registerUser(ctx, 'refresh');
    const r1 = await ctx.http().post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: u.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);
    // Reusing the old token (stolen copy) revokes the session...
    await ctx.http().post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: u.refreshToken }).expect(401);
    // ...so even the legitimately rotated token stops working.
    await ctx.http().post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: r1.body.refreshToken }).expect(401);
    await ctx.http().get('/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
  });

  it('lists devices and revokes another session immediately', async () => {
    const u = await registerUser(ctx, 'devices');
    const phone = await ctx.http().post('/auth/login').set('X-Client', 'mobile').set('X-Device-Name', 'Pixel 9').send({ email: u.email, password: u.password }).expect(200);
    const list = await u.auth(ctx.http().get('/auth/sessions')).expect(200);
    expect(list.body.sessions).toHaveLength(2);
    const pixel = list.body.sessions.find((s: { deviceName: string }) => s.deviceName === 'Pixel 9');
    expect(pixel.current).toBe(false);
    await u.auth(ctx.http().delete(`/auth/sessions/${pixel.id}`)).expect(200);
    await ctx.http().get('/auth/me').set('Authorization', `Bearer ${phone.body.accessToken}`).expect(401);
    await u.auth(ctx.http().get('/auth/me')).expect(200);
  });
});

describe('auth: TOTP 2FA', () => {
  it('enables 2FA, requires code on login, accepts recovery code once', async () => {
    const u = await registerUser(ctx, 'totp');
    const setup = await u.auth(ctx.http().post('/auth/2fa/setup')).expect(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const en = await u.auth(ctx.http().post('/auth/2fa/enable')).send({ code: authenticator.generate(setup.body.secret) }).expect(200);
    expect(en.body.recoveryCodes).toHaveLength(8);

    const need = await ctx.http().post('/auth/login').send({ email: u.email, password: u.password }).expect(401);
    expect(need.body.code).toBe('TOTP_REQUIRED');
    const code = authenticator.generate(setup.body.secret);
    await ctx.http().post('/auth/login').send({ email: u.email, password: u.password, totp: code }).expect(200);
    // same code cannot be replayed
    const replay = await ctx.http().post('/auth/login').send({ email: u.email, password: u.password, totp: code }).expect(401);
    expect(replay.body.code).toBe('TOTP_INVALID');

    const rc = en.body.recoveryCodes[0];
    await ctx.http().post('/auth/login').send({ email: u.email, password: u.password, totp: rc }).expect(200);
    await ctx.http().post('/auth/login').send({ email: u.email, password: u.password, totp: rc }).expect(401);
  });
});

describe('auth: OAuth (Google/Apple id_token)', () => {
  it('creates an account from a verified Google token and links by sub next time', async () => {
    const oauth = ctx.app.get(OAuthService);
    const email = uniqueEmail('google');
    oauth.verifier = async () => ({ sub: 'g-123-' + email, email, email_verified: true, name: 'Gulnora' });
    const r = await ctx.http().post('/auth/oauth/google').set('X-Client', 'mobile').send({ idToken: 'x'.repeat(30) }).expect(200);
    expect(r.body.user.email).toBe(email);
    expect(r.body.user.emailVerified).toBe(true);
    const again = await ctx.http().post('/auth/oauth/google').set('X-Client', 'mobile').send({ idToken: 'x'.repeat(30) }).expect(200);
    expect(again.body.user.id).toBe(r.body.user.id);
  });

  it('refuses to auto-link an existing account when the provider email is unverified', async () => {
    const u = await registerUser(ctx, 'apple');
    const oauth = ctx.app.get(OAuthService);
    oauth.verifier = async () => ({ sub: 'apple-sub-' + u.email, email: u.email, email_verified: 'false' });
    await ctx.http().post('/auth/oauth/apple').send({ idToken: 'y'.repeat(30) }).expect(409);
  });

  it('rejects a bad token', async () => {
    const oauth = ctx.app.get(OAuthService);
    oauth.verifier = async () => {
      throw new Error('bad signature');
    };
    await ctx.http().post('/auth/oauth/google').send({ idToken: 'z'.repeat(30) }).expect(401);
  });
});

describe('auth: email verification & password reset', () => {
  it('verifies email via the emailed link and resets password (revoking sessions)', async () => {
    const mail = ctx.app.get(MailService);
    const u = await registerUser(ctx, 'verify');
    const verifyMail = mail.outbox.findLast((m) => m.to === u.email && m.text.includes('verify-email?token='))!;
    const token = /token=([\w-]+)/.exec(verifyMail.text)![1];
    await ctx.http().post('/auth/verify-email').send({ token }).expect(200);
    await ctx.http().post('/auth/verify-email').send({ token }).expect(400); // single use
    const me = await u.auth(ctx.http().get('/auth/me')).expect(200);
    expect(me.body.user.emailVerified).toBe(true);

    await ctx.http().post('/auth/password/forgot').send({ email: u.email }).expect(200);
    const resetMail = mail.outbox.findLast((m) => m.to === u.email && m.text.includes('reset-password?token='))!;
    const rt = /token=([\w-]+)/.exec(resetMail.text)![1];
    await ctx.http().post('/auth/password/reset').send({ token: rt, password: 'brand new password 1' }).expect(200);
    await u.auth(ctx.http().get('/auth/me')).expect(401);
    await ctx.http().post('/auth/login').send({ email: u.email, password: 'brand new password 1' }).expect(200);
  });
});
