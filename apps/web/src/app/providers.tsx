'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { I18nProvider } from '@/lib/i18n';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  useEffect(() => {
    // PWA: offline app shell. Registered only in production builds to keep dev HMR sane.
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        {children}
        <Toaster richColors position="bottom-right" />
      </I18nProvider>
    </QueryClientProvider>
  );
}
