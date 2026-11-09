'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Flag, Lock } from 'lucide-react';
import { use, useState } from 'react';
import { formatBytes, type NodeDto } from '@maxcloud/shared';
import { Logo } from '@/components/brand';
import { NodeIcon } from '@/components/files/file-icon';
import { PreviewDialog } from '@/components/files/preview-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';

interface Meta {
  requiresPassword: boolean;
  unlocked: boolean;
  allowDownload?: boolean;
  expiresAt?: string | null;
  sharedBy?: string;
  node?: NodeDto;
}

export default function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const base = `/public/shares/${token}`;
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | undefined>();
  const [preview, setPreview] = useState<NodeDto | null>(null);

  const meta = useQuery({ queryKey: ['share', token], queryFn: () => get<Meta>(base), retry: false });
  const isFolder = meta.data?.node?.type === 'FOLDER';
  const listing = useQuery({
    queryKey: ['share-files', token, folder],
    queryFn: () => get<{ items: NodeDto[]; breadcrumbs: { id: string; name: string }[] }>(`${base}/files${folder ? `?parentId=${folder}` : ''}`),
    enabled: !!meta.data?.unlocked && isFolder,
  });

  const download = async (n?: NodeDto) => {
    const r = await get<{ url: string }>(`${base}/download${n ? `?nodeId=${n.id}` : ''}`);
    location.href = r.url;
  };

  let body: React.ReactNode;
  if (meta.isLoading) body = <p className="text-sm text-muted-foreground">Loading…</p>;
  else if (meta.error) {
    const e = meta.error as ApiError;
    body = (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{e.code === 'LINK_EXPIRED' ? 'This link has expired' : 'Link not found'}</CardTitle>
          <CardDescription>Ask the person who shared it for a new link.</CardDescription>
        </CardHeader>
      </Card>
    );
  } else if (meta.data && !meta.data.unlocked) {
    body = (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-5" /> Password required
          </CardTitle>
          <CardDescription>Enter the password you were given to open this link.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post(`${base}/unlock`, { password });
                await qc.invalidateQueries({ queryKey: ['share', token] });
              } catch (x) {
                setPwError(x instanceof ApiError ? x.message : 'Network error');
              }
            }}
          >
            <Input type="password" aria-label="Link password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            {pwError && <p className="text-sm text-destructive">{pwError}</p>}
            <Button type="submit">Open</Button>
          </form>
        </CardContent>
      </Card>
    );
  } else if (meta.data?.node) {
    const node = meta.data.node;
    body = (
      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold" data-testid="share-title">
              {node.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Shared by {meta.data.sharedBy}
              {meta.data.expiresAt && ` · available until ${new Date(meta.data.expiresAt).toLocaleDateString()}`}
            </p>
          </div>
          {!isFolder && meta.data.allowDownload && (
            <Button onClick={() => download()}>
              <Download /> Download ({formatBytes(node.size)})
            </Button>
          )}
        </div>
        {isFolder ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-1 border-b px-4 py-2 text-sm">
              {listing.data?.breadcrumbs.map((b, i) => (
                <span key={b.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3" />}
                  <button className="hover:underline" onClick={() => setFolder(i === 0 ? undefined : b.id)}>
                    {b.name}
                  </button>
                </span>
              ))}
            </div>
            <ul>
              {listing.data?.items.length === 0 && <li className="p-8 text-center text-sm text-muted-foreground">Empty folder</li>}
              {listing.data?.items.map((n) => (
                <li key={n.id} className="flex items-center gap-3 border-b px-4 py-2 last:border-0">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => (n.type === 'FOLDER' ? setFolder(n.id) : setPreview(n))}>
                    <span className="flex size-9 items-center justify-center">
                      <NodeIcon node={n} thumbPath={`${base}/thumbnail?nodeId=${n.id}`} />
                    </span>
                    <span className="truncate text-sm">{n.name}</span>
                  </button>
                  <span className="hidden text-sm text-muted-foreground sm:block">{n.type === 'FILE' ? formatBytes(n.size) : ''}</span>
                  {n.type === 'FILE' && meta.data?.allowDownload && (
                    <Button size="icon" variant="ghost" aria-label={`Download ${n.name}`} onClick={() => download(n)}>
                      <Download />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-4">
              <div className="flex size-48 items-center justify-center">
                <NodeIcon node={node} size="lg" thumbPath={`${base}/thumbnail`} />
              </div>
              <Button variant="outline" onClick={() => setPreview(node)}>
                Preview
              </Button>
            </CardContent>
          </Card>
        )}
        <PreviewDialog
          node={preview}
          onClose={() => setPreview(null)}
          inlinePath={(n) => `${base}/download?inline=1&nodeId=${n.id}`}
          downloadPath={meta.data.allowDownload ? (n) => `${base}/download?nodeId=${n.id}` : null}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <Logo />
        <Button variant="outline" size="sm" asChild>
          <a href="/register">Get 5 GB free</a>
        </Button>
      </header>
      <main className="flex flex-1 justify-center px-4 py-8">{body}</main>
      <footer className="px-4 py-4 text-center text-xs text-muted-foreground">
        <a href={`/legal/dmca?link=${token}`} className="inline-flex items-center gap-1 hover:underline">
          <Flag className="size-3" /> Report abuse or copyright infringement
        </a>
      </footer>
    </div>
  );
}
