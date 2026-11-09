import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config';
import { AppError, Errors } from '../common/errors';
import { HttpStatus } from '@nestjs/common';

export interface OAuthIdentity {
  provider: 'google' | 'apple';
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/**
 * Verifies ID tokens from Google Identity Services and Sign in with Apple.
 * The clients (web GIS button, Apple JS, native SDKs) obtain the id_token;
 * we only verify signature, issuer, audience and expiry.
 */
@Injectable()
export class OAuthService {
  /** Overridable in tests. */
  verifier: (token: string, provider: 'google' | 'apple') => Promise<JWTPayload> = async (token, provider) => {
    const c = config();
    if (provider === 'google') {
      if (!c.GOOGLE_CLIENT_ID) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Google sign-in is not configured');
      const { payload } = await jwtVerify(token, googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: c.GOOGLE_CLIENT_ID.split(','),
      });
      return payload;
    }
    if (!c.APPLE_CLIENT_ID) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Apple sign-in is not configured');
    const { payload } = await jwtVerify(token, appleJwks, { issuer: 'https://appleid.apple.com', audience: c.APPLE_CLIENT_ID.split(',') });
    return payload;
  };

  async verify(provider: 'google' | 'apple', idToken: string): Promise<OAuthIdentity> {
    let p: JWTPayload;
    try {
      p = await this.verifier(idToken, provider);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw Errors.unauth('Invalid identity token');
    }
    const email = typeof p.email === 'string' ? p.email.toLowerCase() : '';
    if (!p.sub || !email) throw Errors.unauth('Identity token has no email');
    // Apple sends email_verified as string "true"
    const ev = p.email_verified === true || p.email_verified === 'true';
    return { provider, sub: p.sub, email, emailVerified: ev, name: typeof p.name === 'string' ? p.name : undefined };
  }
}
