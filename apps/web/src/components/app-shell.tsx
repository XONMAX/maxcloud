'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { CreditCard, FolderOpen, LogOut, Menu, Settings, Shield, Trash2, Users } from 'lucide-react';
import { formatBytes } from '@maxcloud/shared';
import { Logo } from '@/components/brand';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/primitives';
import { useLogout, useRequireUser } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { StorageBanner } from './storage-banner';

export function AppShell({ children }: { children: ReactNode }) {
  const user = useRequireUser();
  const { t } = useI18n();
  const pathname = usePathname();
  const logout = useLogout();
  const [open, setOpen] = useState(false);

  if (!user) return <div className="flex min-h-dvh items-center justify-center text-muted-foreground">{t('common.loading')}</div>;

  const used = user.usedBytes;
  const pct = user.quotaBytes > 0 ? (used / user.quotaBytes) * 100 : 100;
  const nav = [
    { href: '/drive', label: t('nav.drive'), icon: FolderOpen },
    { href: '/shared', label: t('nav.shared'), icon: Users },
    { href: '/trash', label: t('nav.trash'), icon: Trash2 },
    { href: '/billing', label: t('nav.billing'), icon: CreditCard },
    { href: '/settings', label: t('nav.settings'), icon: Settings },
    ...(user.role === 'ADMIN' ? [{ href: '/admin', label: t('nav.admin'), icon: Shield }] : []),
  ];

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <Logo className="mb-4 px-2 py-1" />
      {nav.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          onClick={() => setOpen(false)}
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
            pathname.startsWith(n.href) && 'bg-accent text-foreground',
          )}
        >
          <n.icon className="size-4" />
          {n.label}
        </Link>
      ))}
      <div className="mt-auto flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="storage-meter">
        <div className="text-xs text-muted-foreground">{t('storage.used', { used: formatBytes(used), quota: formatBytes(user.quotaBytes) })}</div>
        <Progress value={pct} indicatorClassName={pct >= 100 ? 'bg-destructive' : pct >= 90 ? 'bg-warning' : undefined} />
        {user.planId !== 's1000' && (
          <Button asChild size="sm" variant="secondary">
            <Link href="/billing">{t('storage.upgrade')}</Link>
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-1 pt-2">
        <LocaleSwitcher />
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut /> {t('nav.logout')}
        </Button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r bg-muted/30 md:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 w-72 bg-background" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Menu" onClick={() => setOpen(true)}>
            <Menu />
          </Button>
          <Logo />
        </header>
        <StorageBanner user={user} />
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
