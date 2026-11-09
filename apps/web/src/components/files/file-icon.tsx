'use client';
import { useQuery } from '@tanstack/react-query';
import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder, type LucideIcon } from 'lucide-react';
import type { NodeDto } from '@maxcloud/shared';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, text: FileText, document: FileText, archive: FileArchive };

/** Thumbnail when the worker made one, otherwise a type icon. `thumbPath` lets public shares use their own endpoint. */
export function NodeIcon({ node, size = 'sm', thumbPath }: { node: NodeDto; size?: 'sm' | 'lg'; thumbPath?: string }) {
  const thumb = useQuery({
    queryKey: ['thumb', node.id, thumbPath],
    queryFn: () => get<{ url: string }>(thumbPath ?? `/files/${node.id}/thumbnail`),
    enabled: node.hasThumbnail,
    staleTime: 5 * 3600_000,
  });
  const box = size === 'lg' ? 'size-full' : 'size-9';
  if (node.type === 'FOLDER') return <Folder className={cn(size === 'lg' ? 'size-14' : 'size-6', 'fill-primary/20 text-primary')} />;
  if (thumb.data?.url)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={thumb.data.url} alt="" loading="lazy" className={cn(box, 'rounded object-cover')} />;
  const Icon = ICONS[node.kind ?? ''] ?? File;
  return <Icon className={cn(size === 'lg' ? 'size-14' : 'size-6', 'text-muted-foreground')} />;
}
