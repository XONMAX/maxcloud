'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { NodeDto } from '@maxcloud/shared';
import { NodeIcon } from '@/components/files/file-icon';
import { Badge } from '@/components/ui/primitives';
import { get } from '@/lib/api';

type SharedItem = NodeDto & { role: 'VIEWER' | 'EDITOR'; sharedBy: { name: string; email: string } };

export default function SharedPage() {
  const q = useQuery({ queryKey: ['shared-with-me'], queryFn: () => get<{ items: SharedItem[] }>('/files/shared-with-me') });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Shared with me</h1>
        <p className="text-sm text-muted-foreground">Folders other people shared with you. Files you add to them use the owner's storage.</p>
      </div>
      <ul className="overflow-hidden rounded-xl border bg-card">
        {q.data?.items.length === 0 && <li className="p-12 text-center text-sm text-muted-foreground">Nothing shared with you yet</li>}
        {q.data?.items.map((n) => (
          <li key={n.id}>
            <Link href={`/drive?folder=${n.id}`} className="flex items-center gap-3 border-b px-4 py-3 last:border-0 hover:bg-accent/50">
              <NodeIcon node={n} />
              <span className="min-w-0 flex-1 truncate text-sm">{n.name}</span>
              <span className="hidden text-sm text-muted-foreground sm:block">{n.sharedBy.name}</span>
              <Badge variant="outline">{n.role === 'EDITOR' ? 'Can edit' : 'View only'}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
