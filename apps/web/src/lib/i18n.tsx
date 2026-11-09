'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Locale = 'uz' | 'ru' | 'en';

/**
 * UI strings. English is the source; uz/ru cover the main flows.
 * Missing keys fall back to English (see t()).
 */
const en = {
  'nav.drive': 'My files',
  'nav.shared': 'Shared with me',
  'nav.trash': 'Trash',
  'nav.settings': 'Settings',
  'nav.billing': 'Plan & billing',
  'nav.admin': 'Admin',
  'nav.logout': 'Sign out',
  'auth.login': 'Sign in',
  'auth.register': 'Create account',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.name': 'Your name',
  'auth.totp': 'Authenticator code',
  'auth.totpHint': 'Enter the 6-digit code from your app or a recovery code.',
  'auth.forgot': 'Forgot password?',
  'auth.noAccount': "Don't have an account?",
  'auth.haveAccount': 'Already have an account?',
  'auth.google': 'Continue with Google',
  'auth.apple': 'Continue with Apple',
  'auth.or': 'or',
  'auth.terms': 'By creating an account you agree to the Terms and Privacy Policy.',
  'storage.used': '{used} of {quota} used',
  'storage.upgrade': 'Get more storage',
  'files.upload': 'Upload',
  'files.newFolder': 'New folder',
  'files.empty': 'This folder is empty. Drop files here to upload.',
  'files.search': 'Search files',
  'files.name': 'Name',
  'files.size': 'Size',
  'files.modified': 'Modified',
  'landing.title': 'Cloud storage for your phone and PC, for less.',
  'landing.subtitle': 'Back up photos automatically, sync your files, and share them safely. 5 GB free, upgrades from 11 900 so\'m a month.',
  'landing.cta': 'Start free',
  'pricing.month': 'Monthly',
  'pricing.year': 'Yearly (2 months free)',
  'pricing.perMonth': '/mo',
  'pricing.perYear': '/yr',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.loading': 'Loading…',
};
type Key = keyof typeof en;

const uz: Partial<Record<Key, string>> = {
  'nav.drive': 'Mening fayllarim',
  'nav.shared': 'Men bilan ulashilgan',
  'nav.trash': 'Savat',
  'nav.settings': 'Sozlamalar',
  'nav.billing': 'Tarif va to\'lov',
  'nav.admin': 'Admin',
  'nav.logout': 'Chiqish',
  'auth.login': 'Kirish',
  'auth.register': 'Ro\'yxatdan o\'tish',
  'auth.email': 'Email',
  'auth.password': 'Parol',
  'auth.name': 'Ismingiz',
  'auth.totp': 'Autentifikator kodi',
  'auth.totpHint': 'Ilovadagi 6 xonali kodni yoki tiklash kodini kiriting.',
  'auth.forgot': 'Parolni unutdingizmi?',
  'auth.noAccount': 'Hisobingiz yo\'qmi?',
  'auth.haveAccount': 'Hisobingiz bormi?',
  'auth.google': 'Google orqali davom etish',
  'auth.apple': 'Apple orqali davom etish',
  'auth.or': 'yoki',
  'auth.terms': 'Hisob yaratish orqali siz Foydalanish shartlari va Maxfiylik siyosatiga rozilik bildirasiz.',
  'storage.used': '{quota} dan {used} ishlatilgan',
  'storage.upgrade': 'Ko\'proq joy olish',
  'files.upload': 'Yuklash',
  'files.newFolder': 'Yangi papka',
  'files.empty': 'Bu papka bo\'sh. Yuklash uchun fayllarni shu yerga tashlang.',
  'files.search': 'Fayllarni qidirish',
  'files.name': 'Nomi',
  'files.size': 'Hajmi',
  'files.modified': 'O\'zgartirilgan',
  'landing.title': 'Telefon va kompyuteringiz uchun arzon bulutli xotira.',
  'landing.subtitle': 'Rasmlarni avtomatik zaxiralang, fayllarni sinxronlang va xavfsiz ulashing. 5 GB bepul, kengaytirish oyiga 11 900 so\'mdan.',
  'landing.cta': 'Bepul boshlash',
  'pricing.month': 'Oylik',
  'pricing.year': 'Yillik (2 oy bepul)',
  'pricing.perMonth': '/oy',
  'pricing.perYear': '/yil',
  'common.cancel': 'Bekor qilish',
  'common.save': 'Saqlash',
  'common.delete': 'O\'chirish',
  'common.loading': 'Yuklanmoqda…',
};

const ru: Partial<Record<Key, string>> = {
  'nav.drive': 'Мои файлы',
  'nav.shared': 'Доступные мне',
  'nav.trash': 'Корзина',
  'nav.settings': 'Настройки',
  'nav.billing': 'Тариф и оплата',
  'nav.admin': 'Админ',
  'nav.logout': 'Выйти',
  'auth.login': 'Войти',
  'auth.register': 'Создать аккаунт',
  'auth.email': 'Email',
  'auth.password': 'Пароль',
  'auth.name': 'Ваше имя',
  'auth.totp': 'Код из приложения',
  'auth.totpHint': 'Введите 6-значный код или резервный код.',
  'auth.forgot': 'Забыли пароль?',
  'auth.noAccount': 'Нет аккаунта?',
  'auth.haveAccount': 'Уже есть аккаунт?',
  'auth.google': 'Продолжить с Google',
  'auth.apple': 'Продолжить с Apple',
  'auth.or': 'или',
  'storage.used': 'Использовано {used} из {quota}',
  'storage.upgrade': 'Больше места',
  'files.upload': 'Загрузить',
  'files.newFolder': 'Новая папка',
  'files.empty': 'Папка пуста. Перетащите сюда файлы.',
  'files.search': 'Поиск файлов',
  'landing.title': 'Облачное хранилище для телефона и ПК — дешевле.',
  'landing.cta': 'Начать бесплатно',
  'pricing.month': 'Помесячно',
  'pricing.year': 'За год (2 месяца бесплатно)',
  'common.cancel': 'Отмена',
  'common.save': 'Сохранить',
  'common.delete': 'Удалить',
  'common.loading': 'Загрузка…',
};

const DICTS: Record<Locale, Partial<Record<Key, string>>> = { en, uz, ru };

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: Key, vars?: Record<string, string | number>) => string;
}
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('uz');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('mc_locale') as Locale | null;
      if (saved && saved in DICTS) setLocaleState(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('mc_locale', l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  }, []);
  const t = useCallback(
    (k: Key, vars?: Record<string, string | number>) => {
      let s = DICTS[locale][k] ?? en[k];
      if (vars) for (const [vk, vv] of Object.entries(vars)) s = s.replace(`{${vk}}`, String(vv));
      return s;
    },
    [locale],
  );
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n outside provider');
  return c;
}
