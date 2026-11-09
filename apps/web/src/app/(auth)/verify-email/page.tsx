'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const [msg, setMsg] = useState('Verifying…');
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    post('/auth/verify-email', { token })
      .then(() => setMsg('Your email is confirmed. Thank you!'))
      .catch((e) => setMsg(e instanceof ApiError ? e.message : 'Network error'));
  }, [token]);
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Email confirmation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p>{msg}</p>
        <Link href="/drive" className="text-primary underline">
          Go to my files
        </Link>
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
