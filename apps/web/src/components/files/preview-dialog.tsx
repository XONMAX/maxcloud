'use client';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { NodeDto } from '@maxcloud/shared';
import { formatBytes } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { get } from '@/lib/api';

/** In-app preview for images, video, audio, PDF and text. Paths are overridable for public shares. */
export function PreviewDialog({
  node,
  onClose,
  inlinePath,
  downloadPath,
}: {
  node: NodeDto | null;
  onClose: () => void;
  inlinePath?: (n: NodeDto) => string;
  downloadPath?: ((n: NodeDto) => string) | null;
}) {
  const kind = node?.kind;
  const previewable = !!node && ['image', 'video', 'audio', 'pdf', 'text'].includes(kind ?? '');
  const url = useQuery({
    queryKey: ['inline', node?.id, inlinePath?.name],
    queryFn: () => get<{ url: string }>(inlinePath ? inlinePath(node!) : `/files/${node!.id}/download?inline=1`),
    enabled: previewable,
    staleTime: 30 * 60_000,
  });
  const text = useQuery({
    queryKey: ['inline-text', url.data?.url],
    queryFn: async () => (await fetch(url.data!.url, { headers: { Range: 'bytes=0-200000' } })).text(),
    enabled: kind === 'text' && !!url.data,
  });

  const download = async () => {
    if (!node) return;
    const r = await get<{ url: string }>(downloadPath ? downloadPath(node) : `/files/${node.id}/download`);
    location.href = r.url;
  };

  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(64rem,calc(100vw-2rem))] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{node?.name}</DialogTitle>
          <DialogDescription>{node && formatBytes(node.size)}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-muted/40" data-testid="preview">
          {!previewable && <p className="p-8 text-sm text-muted-foreground">No preview for this file type.</p>}
          {previewable && !url.data && <p className="p-8 text-sm text-muted-foreground">Loading preview…</p>}
          {url.data && kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url.data.url} alt={node!.name} className="max-h-[70vh] object-contain" />
          )}
          {url.data && kind === 'video' && <video src={url.data.url} controls className="max-h-[70vh] w-full" />}
          {url.data && kind === 'audio' && <audio src={url.data.url} controls className="w-full p-6" />}
          {url.data && kind === 'pdf' && <iframe src={url.data.url} title={node!.name} className="h-[70vh] w-full bg-white" />}
          {kind === 'text' && text.data !== undefined && <pre className="max-h-[70vh] w-full overflow-auto p-4 text-left text-xs whitespace-pre-wrap">{text.data}</pre>}
        </div>
        {downloadPath !== null && (
          <Button onClick={download} className="w-fit">
            <Download /> Download
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
