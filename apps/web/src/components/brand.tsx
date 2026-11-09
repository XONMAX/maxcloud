import Link from 'next/link';
import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M9 21.5a4.5 4.5 0 0 1 .6-8.96A6 6 0 0 1 21.3 12a4.75 4.75 0 0 1 1.2 9.5H9Z" fill="white" />
      </svg>
      <span>MaxCloud</span>
    </Link>
  );
}
