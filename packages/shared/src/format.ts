import type { Currency } from './plans';

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

/** Format minor units (cents / tiyin) for display. */
export function formatMoney(minor: number, currency: Currency): string {
  if (currency === 'UZS') {
    const sum = Math.round(minor / 100);
    return `${sum.toLocaleString('en-US').replace(/,/g, ' ')} so'm`;
  }
  return `$${(minor / 100).toFixed(2)}`;
}

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'archive' | 'text' | 'other';

export function fileKind(mime: string | null | undefined, name = ''): FileKind {
  const m = (mime || '').toLowerCase();
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log'].includes(ext)) return 'text';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || m.includes('zip')) return 'archive';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'].includes(ext)) return 'document';
  return 'other';
}
