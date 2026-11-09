'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { SessionDto } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { ApiError, del, get, post } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { relativeTime } from '@/lib/utils';

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : 'Network error';
}

function PasswordCard() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out all your other devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-sm gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/auth/password', { currentPassword: cur, newPassword: next });
              toast.success('Password changed');
              setCur('');
              setNext('');
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <Label htmlFor="cur">Current password</Label>
          <Input id="cur" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          <Label htmlFor="new">New password</Label>
          <Input id="new" type="password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          <Button type="submit" className="w-fit">
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorCard() {
  const me = useMe();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState({ open: false, password: '', code: '' });
  const enabled = me.data?.totpEnabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication {enabled ? <Badge>On</Badge> : <Badge variant="secondary">Off</Badge>}
        </CardTitle>
        <CardDescription>Use Google Authenticator, Authy or any TOTP app.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!enabled && !setup && (
          <Button className="w-fit" onClick={async () => setSetup(await post('/auth/2fa/setup'))}>
            Turn on 2FA
          </Button>
        )}
        {setup && (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
                setCodes(r.recoveryCodes);
                setSetup(null);
                qc.invalidateQueries({ queryKey: ['me'] });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="QR code for your authenticator app" className="size-44 rounded border bg-white p-2" />
            <p className="text-xs text-muted-foreground">
              Can't scan? Enter this key: <code className="break-all">{setup.secret}</code>
            </p>
            <Label htmlFor="code">6-digit code</Label>
            <Input id="code" className="max-w-40" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.trim())} />
            <Button type="submit" className="w-fit">
              Confirm
            </Button>
          </form>
        )}
        {enabled && (
          <Button variant="outline" className="w-fit" onClick={() => setDisable({ ...disable, open: true })}>
            Turn off 2FA
          </Button>
        )}
      </CardContent>

      <Dialog open={!!codes} onOpenChange={() => setCodes(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>Each code works once if you lose your phone. They won't be shown again.</DialogDescription>
          </DialogHeader>
          <pre className="grid grid-cols-2 gap-2 rounded bg-muted p-4 font-mono text-sm" data-testid="recovery-codes">
            {codes?.map((c) => <span key={c}>{c}</span>)}
          </pre>
          <Button onClick={() => navigator.clipboard.writeText(codes?.join('\n') ?? '')}>Copy</Button>
        </DialogContent>
      </Dialog>

      <Dialog open={disable.open} onOpenChange={(o) => setDisable({ ...disable, open: o })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/auth/2fa/disable', { password: disable.password, code: disable.code });
                setDisable({ open: false, password: '', code: '' });
                qc.invalidateQueries({ queryKey: ['me'] });
                toast.success('2FA turned off');
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <Label htmlFor="dpw">Password</Label>
            <Input id="dpw" type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} />
            <Label htmlFor="dcode">Code or recovery code</Label>
            <Input id="dcode" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value.trim() })} />
            <Button type="submit" variant="destructive">
              Turn off
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DevicesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ sessions: SessionDto[] }>('/auth/sessions') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sessions'] });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>Everywhere you're signed in. Sign out anything you don't recognise.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {q.data?.sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-md border p-3" data-testid="session-row">
            {/Android|iOS/.test(s.deviceName) ? <Smartphone className="size-5" /> : <Laptop className="size-5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {s.deviceName} {s.current && <Badge variant="secondary">This device</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.ip ?? 'unknown IP'} · active {relativeTime(s.lastUsedAt)}
              </div>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await del(`/auth/sessions/${s.id}`);
                  refresh();
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        ))}
        {(q.data?.sessions.length ?? 0) > 1 && (
          <Button
            variant="ghost"
            className="w-fit"
            onClick={async () => {
              await post('/auth/sessions/revoke-others');
              refresh();
            }}
          >
            Sign out all other devices
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const me = useMe();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">{me.data?.email}</p>
      </div>
      {me.data && !me.data.emailVerified && (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 text-sm">
            Please confirm your email address.
            <Button size="sm" variant="outline" onClick={() => post('/auth/verify-email/resend').then(() => toast.success('Sent'))}>
              Resend email
            </Button>
          </CardContent>
        </Card>
      )}
      <PasswordCard />
      <TwoFactorCard />
      <DevicesCard />
      <AccountDataCard />
    </div>
  );
}

function AccountDataCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>Download a copy of everything, or delete your account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" asChild>
          <a href="/api/account/export">Download account data (JSON)</a>
        </Button>
        <Button
          variant="destructive"
          onClick={async () => {
            if (!confirm('Delete your account and all files? This cannot be undone after 7 days.')) return;
            try {
              await post('/account/delete');
              toast.success('Account scheduled for deletion. Sign in within 7 days to cancel.');
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        >
          Delete account
        </Button>
      </CardContent>
    </Card>
  );
}
