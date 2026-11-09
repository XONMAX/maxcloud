'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { UserDto } from '@maxcloud/shared';
import { ApiError, get, post } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await get<{ user: UserDto }>('/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

/** Redirects to /login when signed out. Returns the user once known. */
export function useRequireUser() {
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (me.data === null) router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [me.data, router]);
  return me.data ?? undefined;
}

export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  };
}
