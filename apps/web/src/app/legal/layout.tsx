import Link from 'next/link';
import { Logo } from '@/components/brand';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Logo />
          <nav className="flex gap-4 text-sm">
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/dmca">DMCA & abuse</Link>
          </nav>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
        {children}
      </article>
    </div>
  );
}
