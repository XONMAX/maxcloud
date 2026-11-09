'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, FolderSync, Lock, Share2 } from 'lucide-react';
import { Logo } from '@/components/brand';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { PricingTable } from '@/components/pricing';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

const FEATURES = [
  { icon: Camera, title: 'Photo auto-backup', text: 'Your camera roll uploads on Wi-Fi in the background. Free up space on your phone once it is safe.' },
  { icon: FolderSync, title: 'Sync folder on your PC', text: 'Windows, macOS and Linux. Edit offline, we sync when you are back.' },
  { icon: Share2, title: 'Share with a link', text: 'Password and expiry date on any link. Shared folders for family and teams.' },
  { icon: Lock, title: 'Private by design', text: 'AES-256 encryption at rest, TLS in transit, two-factor sign-in, virus scanning.' },
];

export default function Landing() {
  const { t } = useI18n();
  const me = useMe();
  const router = useRouter();
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Logo />
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          {me.data ? (
            <Button asChild>
              <Link href="/drive">{t('nav.drive')}</Link>
            </Button>
          ) : (
            <>
              <Button variant="ghost" asChild>
                <Link href="/login">{t('auth.login')}</Link>
              </Button>
              <Button asChild className="hidden sm:inline-flex">
                <Link href="/register">{t('landing.cta')}</Link>
              </Button>
            </>
          )}
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-4 pt-16 pb-12 text-center sm:pt-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t('landing.title')}</h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">{t('landing.subtitle')}</p>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg" asChild>
            <Link href="/register">{t('landing.cta')}</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a href="#pricing">Pricing</a>
          </Button>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-xl border bg-card p-6">
            <f.icon className="size-6 text-primary" />
            <h3 className="mt-4 font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{f.text}</p>
          </div>
        ))}
      </section>
      <section id="pricing" className="mx-auto max-w-7xl px-4 py-16">
        <h2 className="mb-8 text-center text-3xl font-semibold">Simple pricing</h2>
        <PricingTable cta={t('landing.cta')} onSelect={(p, i) => router.push(me.data ? `/billing?plan=${p.id}&interval=${i}` : '/register')} />
      </section>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} MaxCloud</span>
          <nav className="flex gap-4">
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/dmca">DMCA &amp; abuse</Link>
            <a href="https://status.maxcloud.uz">Status</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
