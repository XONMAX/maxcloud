'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [pendingOAuth, setPendingOAuth] = useState<{ provider: 'google' | 'apple'; idToken: string; name?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    const next = params.get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/drive');
  };

  const handleError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') {
      setNeedTotp(true);
      setError(null);
    } else setError(e instanceof ApiError ? e.message : 'Network error');
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      if (pendingOAuth) await post(`/auth/oauth/${pendingOAuth.provider}`, { idToken: pendingOAuth.idToken, name: pendingOAuth.name, totp });
      else await post('/auth/login', { email, password, totp: needTotp ? totp : undefined });
      await done();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const onOAuth = useCallback(
    async (provider: 'google' | 'apple', idToken: string, name?: string) => {
      try {
        await post(`/auth/oauth/${provider}`, { idToken, name });
        await done();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') setPendingOAuth({ provider, idToken, name });
        handleError(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t('auth.login')}</CardTitle>
        <CardDescription>MaxCloud</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!needTotp && <OAuthButtons onToken={onOAuth} />}
        <form onSubmit={submit} className="flex flex-col gap-4">
          {!needTotp ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <Link href="/forgot-password" className="text-xs text-primary hover:underline">
                    {t('auth.forgot')}
                  </Link>
                </div>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="totp">{t('auth.totp')}</Label>
              <Input id="totp" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={totp} onChange={(e) => setTotp(e.target.value.trim())} />
              <p className="text-xs text-muted-foreground">{t('auth.totpHint')}</p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {t('auth.login')}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.noAccount')}{' '}
          <Link href="/register" className="text-primary hover:underline">
            {t('auth.register')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
