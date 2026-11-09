'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { NodeDto } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Input, Label } from '@/components/ui/primitives';
import { ApiError, del, get, post } from '@/lib/api';

interface LinkDto {
  id: string;
  url: string;
  hasPassword: boolean;
  expiresAt: string | null;
  allowDownload: boolean;
  downloadCount: number;
}
interface FolderShareDto {
  id: string;
  role: 'VIEWER' | 'EDITOR';
  grantee: { id: string; email: string; name: string };
}

const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Network error');

export function ShareDialog({ node, onClose }: { node: NodeDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'VIEWER' | 'EDITOR'>('VIEWER');

  const links = useQuery({ queryKey: ['links', node?.id], queryFn: () => get<{ items: LinkDto[] }>(`/share-links?nodeId=${node!.id}`), enabled: !!node });
  const people = useQuery({
    queryKey: ['folder-shares', node?.id],
    queryFn: () => get<{ items: FolderShareDto[] }>(`/folders/${node!.id}/shares`),
    enabled: node?.type === 'FOLDER',
    retry: false,
  });

  // Clipboard can be refused (insecure context, permissions): never let that break the flow.
  const copy = (url: string) =>
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.message('Link created', { description: url }));

  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share "{node?.name}"</DialogTitle>
          <DialogDescription>Anyone with a link can open it. Add a password or expiry for extra safety.</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3 rounded-md border p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const l = await post<LinkDto>('/share-links', {
                nodeId: node!.id,
                password: password || undefined,
                expiresAt: expires ? new Date(expires).toISOString() : undefined,
                allowDownload,
              });
              setPassword('');
              setExpires('');
              await qc.invalidateQueries({ queryKey: ['links', node!.id] });
              void copy(l.url);
            } catch (x) {
              err(x);
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="sl-pw">Password (optional)</Label>
              <Input id="sl-pw" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sl-exp">Expires (optional)</Label>
              <Input id="sl-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
            Allow downloads (off = view only)
          </label>
          <Button type="submit" className="w-fit">
            <Link2 /> Create link
          </Button>
        </form>

        {!!links.data?.items.length && (
          <ul className="grid gap-2" data-testid="share-links">
            {links.data.items.map((l) => (
              <li key={l.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <code className="min-w-0 flex-1 truncate text-xs">{l.url}</code>
                {l.hasPassword && <Badge variant="secondary">password</Badge>}
                {l.expiresAt && <Badge variant="secondary">until {new Date(l.expiresAt).toLocaleDateString()}</Badge>}
                {!l.allowDownload && <Badge variant="secondary">view only</Badge>}
                <Button size="icon" variant="ghost" aria-label="Copy link" onClick={() => copy(l.url)}>
                  <Copy />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete link"
                  onClick={async () => {
                    await del(`/share-links/${l.id}`);
                    qc.invalidateQueries({ queryKey: ['links', node!.id] });
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {node?.type === 'FOLDER' && !people.isError && (
          <div className="grid gap-3 border-t pt-4">
            <div className="text-sm font-medium">Share with people</div>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await post(`/folders/${node.id}/shares`, { email, role });
                  setEmail('');
                  qc.invalidateQueries({ queryKey: ['folder-shares', node.id] });
                  toast.success('Shared');
                } catch (x) {
                  err(x);
                }
              }}
            >
              <Input className="min-w-48 flex-1" type="email" placeholder="name@example.uz" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as 'VIEWER' | 'EDITOR')}>
                <option value="VIEWER">Can view & download</option>
                <option value="EDITOR">Can edit</option>
              </select>
              <Button type="submit">
                <UserPlus /> Share
              </Button>
            </form>
            {people.data?.items.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {s.grantee.name} <span className="text-muted-foreground">{s.grantee.email}</span>
                </span>
                <Badge variant="outline">{s.role === 'EDITOR' ? 'Editor' : 'Viewer'}</Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${s.grantee.email}`}
                  onClick={async () => {
                    await del(`/folders/${node.id}/shares/${s.grantee.id}`);
                    qc.invalidateQueries({ queryKey: ['folder-shares', node.id] });
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
