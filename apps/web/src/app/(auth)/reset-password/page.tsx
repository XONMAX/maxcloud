'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'done' | string>('idle');
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        {state === 'done' ? (
          <p className="text-sm">
            Password changed. All devices were signed out.{' '}
            <Link className="text-primary underline" href="/login">
              Sign in
            </Link>
          </p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/auth/password/reset', { token, password });
                setState('done');
              } catch (err) {
                setState(err instanceof ApiError ? err.message : 'Network error');
              }
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="password">New password</Label>
              <Input id="password" type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {state !== 'idle' && <p className="text-sm text-destructive">{state}</p>}
            <Button type="submit">Save password</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
