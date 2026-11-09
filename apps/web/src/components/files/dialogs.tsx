'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { NodeDto } from '@maxcloud/shared';
import { formatBytes } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Input } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';
import { relativeTime } from '@/lib/utils';

const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Network error');

export function NameDialog({
  open,
  title,
  initial = '',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial, open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onSubmit(name.trim());
              onClose();
            } catch (x) {
              err(x);
            }
          }}
        >
          <Input autoFocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Folder picker: navigate your own tree and choose a destination. */
export function MoveDialog({ node, onClose, onMove }: { node: NodeDto | null; onClose: () => void; onMove: (parentId: string | null) => Promise<void> }) {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => setAt(null), [node]);
  const q = useQuery({
    queryKey: ['folders-picker', at],
    queryFn: () => get<{ items: NodeDto[]; breadcrumbs: { id: string; name: string }[] }>(`/files?limit=1000${at ? `&parentId=${at}` : ''}`),
    enabled: !!node,
  });
  const folders = q.data?.items.filter((n) => n.type === 'FOLDER' && n.id !== node?.id) ?? [];
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move "{node?.name}"</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button className="text-primary hover:underline" onClick={() => setAt(null)}>
            My files
          </button>
          {q.data?.breadcrumbs.map((b) => (
            <span key={b.id} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <button className="text-primary hover:underline" onClick={() => setAt(b.id)}>
                {b.name}
              </button>
            </span>
          ))}
        </div>
        <ul className="max-h-72 overflow-y-auto rounded-md border">
          {folders.length === 0 && <li className="p-3 text-sm text-muted-foreground">No folders here</li>}
          {folders.map((f) => (
            <li key={f.id}>
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => setAt(f.id)}>
                <Folder className="size-4 text-primary" /> {f.name}
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                await onMove(at);
                onClose();
              } catch (x) {
                err(x);
              }
            }}
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface VersionDto {
  id: string;
  size: number;
  createdAt: string;
  current: boolean;
  scanStatus: string;
}

export function VersionsDialog({ node, onClose, onChanged }: { node: NodeDto | null; onClose: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ['versions', node?.id], queryFn: () => get<{ items: VersionDto[] }>(`/files/${node!.id}/versions`), enabled: !!node });
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-5" /> Versions of "{node?.name}"
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">We keep the last 10 versions. Older versions count toward your storage.</p>
        <ul className="grid gap-2">
          {q.data?.items.map((v) => (
            <li key={v.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
              <span className="flex-1">
                {new Date(v.createdAt).toLocaleString()} <span className="text-muted-foreground">· {relativeTime(v.createdAt)}</span>
              </span>
              <span className="text-muted-foreground">{formatBytes(v.size)}</span>
              {v.scanStatus === 'INFECTED' && <Badge variant="destructive">malware</Badge>}
              {v.current ? (
                <Badge>Current</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await post(`/files/${node!.id}/versions/${v.id}/restore`);
                      toast.success('Version restored');
                      q.refetch();
                      onChanged();
                    } catch (x) {
                      err(x);
                    }
                  }}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
