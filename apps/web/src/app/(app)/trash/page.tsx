'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatBytes, type NodeDto } from '@maxcloud/shared';
import { NodeIcon } from '@/components/files/file-icon';
import { Button } from '@/components/ui/button';
import { del, get, post } from '@/lib/api';

type TrashItem = NodeDto & { purgeAt: string };

export default function TrashPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['trash'], queryFn: () => get<{ items: TrashItem[] }>('/trash') });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['trash'] });
    qc.invalidateQueries({ queryKey: ['me'] });
    qc.invalidateQueries({ queryKey: ['files'] });
  };
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Trash</h1>
          <p className="text-sm text-muted-foreground">Items are deleted forever 30 days after you trash them. Trash counts toward your storage.</p>
        </div>
        {!!q.data?.items.length && (
          <Button
            variant="destructive"
            onClick={async () => {
              if (!confirm('Delete everything in Trash forever?')) return;
              const r = await del<{ freedBytes: number }>('/trash');
              toast.success(`Freed ${formatBytes(r.freedBytes)}`);
              refresh();
            }}
          >
            <Trash2 /> Empty trash
          </Button>
        )}
      </div>
      <ul className="overflow-hidden rounded-xl border bg-card" data-testid="trash-list">
        {q.data?.items.length === 0 && <li className="p-12 text-center text-sm text-muted-foreground">Trash is empty</li>}
        {q.data?.items.map((n) => (
          <li key={n.id} className="flex items-center gap-3 border-b px-4 py-2 last:border-0" data-testid="trash-row">
            <span className="flex size-9 items-center justify-center">
              <NodeIcon node={{ ...n, hasThumbnail: false }} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{n.name}</div>
              <div className="text-xs text-muted-foreground">Deleted forever on {new Date(n.purgeAt).toLocaleDateString()}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await post(`/trash/${n.id}/restore`);
                toast.success('Restored');
                refresh();
              }}
            >
              <RotateCcw /> Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${n.name} forever`}
              onClick={async () => {
                await del(`/trash/${n.id}`);
                refresh();
              }}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
