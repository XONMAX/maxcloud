'use client';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { UserDto } from '@maxcloud/shared';

/** Explains grace / read-only / deletion state of the quota engine in plain language. */
export function StorageBanner({ user }: { user: UserDto }) {
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
  let text: string | null = null;
  if (user.storageState === 'GRACE') text = `You're over your storage limit. Free up space or upgrade by ${date(user.graceEndsAt)}, or your account will become read-only.`;
  if (user.storageState === 'READ_ONLY') text = `Your account is read-only. Files above your quota will be deleted on ${date(user.deletionScheduledAt)} unless you free up space or upgrade.`;
  if (user.storageState === 'PENDING_DELETION') text = 'Files above your quota are being removed. Upgrade now to keep the rest safe.';
  if (!text) return null;
  return (
    <div role="alert" data-testid="storage-banner" className="flex items-center gap-3 border-b border-warning/40 bg-warning/15 px-4 py-2 text-sm">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">{text}</span>
      <Link href="/billing" className="font-medium underline">
        Upgrade
      </Link>
    </div>
  );
}
