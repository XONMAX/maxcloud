'use client';
import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const APPLE_CLIENT_ID = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID;

declare global {
  interface Window {
    google?: { accounts: { id: { initialize(o: object): void; renderButton(el: HTMLElement, o: object): void } } };
    AppleID?: { auth: { init(o: object): void; signIn(): Promise<{ authorization: { id_token: string }; user?: { name?: { firstName?: string; lastName?: string } } }> } };
  }
}

/**
 * Google Identity Services + Sign in with Apple JS. Both return an id_token
 * that the API verifies (apps/api/src/auth/oauth.service.ts).
 * Hidden unless NEXT_PUBLIC_GOOGLE_CLIENT_ID / NEXT_PUBLIC_APPLE_CLIENT_ID are set.
 */
export function OAuthButtons({ onToken }: { onToken: (provider: 'google' | 'apple', idToken: string, name?: string) => void }) {
  const { t } = useI18n();
  const googleRef = useRef<HTMLDivElement>(null);
  const [googleReady, setGoogleReady] = useState(false);

  useEffect(() => {
    if (!googleReady || !GOOGLE_CLIENT_ID || !googleRef.current || !window.google) return;
    window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (r: { credential: string }) => onToken('google', r.credential) });
    window.google.accounts.id.renderButton(googleRef.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
  }, [googleReady, onToken]);

  const apple = useCallback(async () => {
    if (!window.AppleID || !APPLE_CLIENT_ID) return;
    window.AppleID.auth.init({ clientId: APPLE_CLIENT_ID, scope: 'name email', redirectURI: `${location.origin}/login`, usePopup: true });
    const r = await window.AppleID.auth.signIn();
    const n = r.user?.name;
    onToken('apple', r.authorization.id_token, n ? `${n.firstName ?? ''} ${n.lastName ?? ''}`.trim() : undefined);
  }, [onToken]);

  if (!GOOGLE_CLIENT_ID && !APPLE_CLIENT_ID) return null;
  return (
    <div className="flex flex-col items-center gap-3">
      {GOOGLE_CLIENT_ID && (
        <>
          <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setGoogleReady(true)} />
          <div ref={googleRef} aria-label={t('auth.google')} />
        </>
      )}
      {APPLE_CLIENT_ID && (
        <>
          <Script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js" strategy="afterInteractive" />
          <Button type="button" variant="outline" className="w-80" onClick={apple}>
             {t('auth.apple')}
          </Button>
        </>
      )}
      <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {t('auth.or')}
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
