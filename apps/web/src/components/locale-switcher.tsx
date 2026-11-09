'use client';
import { useI18n, type Locale } from '@/lib/i18n';

const LABELS: Record<Locale, string> = { uz: "O'zbekcha", ru: 'Русский', en: 'English' };

export function LocaleSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <select
      aria-label="Language"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="h-8 rounded-md border bg-background px-2 text-sm"
    >
      {(Object.keys(LABELS) as Locale[]).map((l) => (
        <option key={l} value={l}>
          {LABELS[l]}
        </option>
      ))}
    </select>
  );
}
