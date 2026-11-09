'use client';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Eye, FolderInput, FolderPlus, History, MoreVertical, Pencil, Search, Share2, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatBytes, type NodeDto } from '@maxcloud/shared';
import { MoveDialog, NameDialog, VersionsDialog } from '@/components/files/dialogs';
import { NodeIcon } from '@/components/files/file-icon';
import { PreviewDialog } from '@/components/files/preview-dialog';
import { ShareDialog } from '@/components/files/share-dialog';
import { UploadPanel } from '@/components/files/upload-panel';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dialog';
import { Badge, Input } from '@/components/ui/primitives';
import { ApiError, del, get, patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { uploader } from '@/lib/uploader';
import { cn, relativeTime } from '@/lib/utils';

interface ListResponse {
  items: NodeDto[];
  nextCursor: string | null;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  breadcrumbs: { id: string; name: string }[];
}

const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Network error');

function Drive() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const folderId = params.get('folder');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [renaming, setRenaming] = useState<NodeDto | null>(null);
  const [moving, setMoving] = useState<NodeDto | null>(null);
  const [sharing, setSharing] = useState<NodeDto | null>(null);
  const [versions, setVersions] = useState<NodeDto | null>(null);
  const [preview, setPreview] = useState<NodeDto | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);

  const key = ['files', folderId, debounced];
  const list = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (debounced) {
        const r = await get<{ items: NodeDto[] }>(`/files/search?q=${encodeURIComponent(debounced)}`);
        return { items: r.items, nextCursor: null, role: 'OWNER', breadcrumbs: [] } as ListResponse;
      }
      const qs = new URLSearchParams({ limit: '200' });
      if (folderId) qs.set('parentId', folderId);
      if (pageParam) qs.set('cursor', pageParam);
      return get<ListResponse>(`/files?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canEdit = !first || first.role !== 'VIEWER';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['files'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  };
  useEffect(() => {
    uploader.onComplete = () => refresh();
    return () => void (uploader.onComplete = undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (n: NodeDto) => {
    if (n.type === 'FOLDER') {
      setQ('');
      router.push(`/drive?folder=${n.id}`);
    } else setPreview(n);
  };
  const download = async (n: NodeDto) => {
    try {
      location.href = (await get<{ url: string }>(`/files/${n.id}/download`)).url;
    } catch (e) {
      err(e);
    }
  };
  const upload = (files: FileList | File[]) => {
    if (!canEdit) return toast.error('You have view-only access to this folder');
    uploader.add(files, folderId);
  };

  return (
    <div
      className={cn('relative mx-auto flex max-w-6xl flex-col gap-4', dragging && 'rounded-xl ring-2 ring-primary ring-offset-4')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-lg font-semibold" aria-label="Breadcrumbs">
          <Link href="/drive" className="hover:underline">
            {t('nav.drive')}
          </Link>
          {first?.breadcrumbs.map((b) => (
            <span key={b.id} className="flex items-center gap-1">
              <ChevronRight className="size-4 text-muted-foreground" />
              <Link href={`/drive?folder=${b.id}`} className="hover:underline">
                {b.name}
              </Link>
            </span>
          ))}
          {first && first.role !== 'OWNER' && <Badge variant="secondary">{first.role === 'EDITOR' ? 'Shared · can edit' : 'Shared · view only'}</Badge>}
        </nav>
        <div className="relative w-full sm:w-64">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input placeholder={t('files.search')} className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('files.search')} />
        </div>
        {canEdit && (
          <>
            <Button variant="outline" onClick={() => setNewFolder(true)}>
              <FolderPlus /> {t('files.newFolder')}
            </Button>
            <Button onClick={() => fileInput.current?.click()}>
              <Upload /> {t('files.upload')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="file-input"
              onChange={(e) => {
                if (e.target.files) upload(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="grid grid-cols-[1fr_auto] gap-4 border-b px-4 py-2 text-xs font-medium text-muted-foreground sm:grid-cols-[1fr_7rem_9rem_2.5rem]">
          <span>{t('files.name')}</span>
          <span className="hidden sm:block">{t('files.size')}</span>
          <span className="hidden sm:block">{t('files.modified')}</span>
          <span />
        </div>
        {list.isLoading && <div className="p-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>}
        {list.isError && <div className="p-8 text-center text-sm text-destructive">{(list.error as Error).message}</div>}
        {!list.isLoading && items.length === 0 && (
          <div className="p-12 text-center text-sm text-muted-foreground">{debounced ? 'No files match your search.' : t('files.empty')}</div>
        )}
        <ul data-testid="file-list">
          {items.map((n) => (
            <li
              key={n.id}
              className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-4 border-b px-4 py-2 last:border-0 hover:bg-accent/50 sm:grid-cols-[1fr_7rem_9rem_2.5rem]"
              onDoubleClick={() => open(n)}
              data-testid="file-row"
              data-name={n.name}
            >
              <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => open(n)}>
                <span className="flex size-9 shrink-0 items-center justify-center">
                  <NodeIcon node={n} />
                </span>
                <span className="truncate text-sm">{n.name}</span>
                {n.versionCount > 1 && <Badge variant="outline">v{n.versionCount}</Badge>}
              </button>
              <span className="hidden text-sm text-muted-foreground sm:block">{n.type === 'FILE' ? formatBytes(n.size) : '—'}</span>
              <span className="hidden text-sm text-muted-foreground sm:block">{relativeTime(n.updatedAt)}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label={`Actions for ${n.name}`}>
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {n.type === 'FILE' && (
                    <>
                      <DropdownMenuItem onSelect={() => setPreview(n)}>
                        <Eye /> Preview
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => download(n)}>
                        <Download /> Download
                      </DropdownMenuItem>
                    </>
                  )}
                  {canEdit && (
                    <>
                      <DropdownMenuItem onSelect={() => setSharing(n)}>
                        <Share2 /> Share
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRenaming(n)}>
                        <Pencil /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setMoving(n)}>
                        <FolderInput /> Move
                      </DropdownMenuItem>
                      {n.type === 'FILE' && (
                        <DropdownMenuItem onSelect={() => setVersions(n)}>
                          <History /> Versions
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                          try {
                            await del(`/files/${n.id}`);
                            toast.success(`"${n.name}" moved to Trash`, {
                              action: { label: 'Undo', onClick: () => post(`/trash/${n.id}/restore`).then(refresh) },
                            });
                            refresh();
                          } catch (e) {
                            err(e);
                          }
                        }}
                      >
                        <Trash2 /> Move to Trash
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <div className="p-3 text-center">
            <Button variant="ghost" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )}
      </div>

      <NameDialog
        open={newFolder}
        title={t('files.newFolder')}
        initial="New folder"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          await post('/folders', { name, parentId: folderId });
          refresh();
        }}
      />
      <NameDialog
        open={!!renaming}
        title="Rename"
        initial={renaming?.name}
        onClose={() => setRenaming(null)}
        onSubmit={async (name) => {
          await patch(`/files/${renaming!.id}/name`, { name });
          refresh();
        }}
      />
      <MoveDialog
        node={moving}
        onClose={() => setMoving(null)}
        onMove={async (parentId) => {
          await patch(`/files/${moving!.id}/parent`, { parentId });
          refresh();
        }}
      />
      <ShareDialog node={sharing} onClose={() => setSharing(null)} />
      <VersionsDialog node={versions} onClose={() => setVersions(null)} onChanged={refresh} />
      <PreviewDialog node={preview} onClose={() => setPreview(null)} />
      <UploadPanel />
    </div>
  );
}

export default function DrivePage() {
  return (
    <Suspense>
      <Drive />
    </Suspense>
  );
}
