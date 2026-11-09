'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function RegisterPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    router.replace('/drive');
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/register', { ...form, locale });
      await finish();
    } catch (e) {
      if (e instanceof ApiError) {
        const issues = (e.body.issues as { message: string }[] | undefined)?.map((i) => i.message).join(', ');
        setError(issues || e.message);
      } else setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const onOAuth = useCallback(async (provider: 'google' | 'apple', idToken: string, name?: string) => {
    try {
      await post(`/auth/oauth/${provider}`, { idToken, name });
      await finish();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Network error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t('auth.register')}</CardTitle>
        <CardDescription>5 GB free</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <OAuthButtons onToken={onOAuth} />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">{t('auth.name')}</Label>
            <Input id="name" required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input id="email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input id="password" type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <p className="text-xs text-muted-foreground">10+ characters</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {t('auth.register')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('auth.terms')}{' '}
            <Link href="/legal/terms" className="underline">
              Terms
            </Link>{' '}
            ·{' '}
            <Link href="/legal/privacy" className="underline">
              Privacy
            </Link>
          </p>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.haveAccount')}{' '}
          <Link href="/login" className="text-primary hover:underline">
            {t('auth.login')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
