/** Transactional email copy in Uzbek (default), Russian and English. */
export type Locale = 'uz' | 'ru' | 'en';
export type TemplateId =
  | 'verify_email'
  | 'reset_password'
  | 'grace_started'
  | 'read_only'
  | 'deletion_warning'
  | 'purged'
  | 'payment_failed'
  | 'renewal_reminder'
  | 'folder_shared';

interface Rendered {
  subject: string;
  text: string;
}

type Vars = Record<string, string | number>;
type Tpl = (v: Vars) => Rendered;

const T: Record<TemplateId, Record<Locale, Tpl>> = {
  verify_email: {
    en: (v) => ({ subject: 'Confirm your MaxCloud email', text: `Hi ${v.name},\n\nConfirm your email: ${v.url}\n\nThe link expires in 24 hours.` }),
    uz: (v) => ({ subject: 'MaxCloud emailingizni tasdiqlang', text: `Salom ${v.name},\n\nEmailingizni tasdiqlang: ${v.url}\n\nHavola 24 soat amal qiladi.` }),
    ru: (v) => ({ subject: 'Подтвердите email в MaxCloud', text: `Здравствуйте, ${v.name}!\n\nПодтвердите email: ${v.url}\n\nСсылка действует 24 часа.` }),
  },
  reset_password: {
    en: (v) => ({ subject: 'Reset your MaxCloud password', text: `Reset your password: ${v.url}\n\nIf you didn't ask for this, ignore this email. The link expires in 1 hour.` }),
    uz: (v) => ({ subject: 'MaxCloud parolini tiklash', text: `Parolni tiklash: ${v.url}\n\nAgar siz so'ramagan bo'lsangiz, bu xatni e'tiborsiz qoldiring. Havola 1 soat amal qiladi.` }),
    ru: (v) => ({ subject: 'Сброс пароля MaxCloud', text: `Сбросить пароль: ${v.url}\n\nЕсли вы не запрашивали сброс, проигнорируйте письмо. Ссылка действует 1 час.` }),
  },
  grace_started: {
    en: (v) => ({ subject: 'Your MaxCloud storage is over the limit', text: `You are using ${v.used} of ${v.quota}. You have until ${v.date} to free up space or upgrade. After that your account becomes read-only.\n\n${v.url}` }),
    uz: (v) => ({ subject: 'MaxCloud xotirangiz limitdan oshdi', text: `Siz ${v.quota} dan ${v.used} ishlatmoqdasiz. ${v.date} gacha joy bo'shating yoki tarifni oshiring. Shundan so'ng hisobingiz faqat o'qish rejimiga o'tadi.\n\n${v.url}` }),
    ru: (v) => ({ subject: 'Хранилище MaxCloud переполнено', text: `Вы используете ${v.used} из ${v.quota}. До ${v.date} освободите место или повысьте тариф. После этого аккаунт перейдёт в режим только для чтения.\n\n${v.url}` }),
  },
  read_only: {
    en: (v) => ({ subject: 'Your MaxCloud account is now read-only', text: `You can still view and download your files, but uploads are paused. Files above your quota will be deleted on ${v.date} unless you free up space or upgrade.\n\n${v.url}` }),
    uz: (v) => ({ subject: 'MaxCloud hisobingiz faqat o\'qish rejimida', text: `Fayllaringizni ko'rish va yuklab olish mumkin, ammo yuklash to'xtatildi. Agar joy bo'shatmasangiz yoki tarifni oshirmasangiz, ${v.date} kuni limitdan ortiq fayllar o'chiriladi.\n\n${v.url}` }),
    ru: (v) => ({ subject: 'Аккаунт MaxCloud в режиме только для чтения', text: `Вы можете просматривать и скачивать файлы, но загрузка приостановлена. ${v.date} файлы сверх квоты будут удалены, если вы не освободите место или не повысите тариф.\n\n${v.url}` }),
  },
  deletion_warning: {
    en: (v) => ({ subject: `${v.days} day(s) until files are deleted`, text: `Files above your quota will be permanently deleted on ${v.date}. Upgrade or delete files to keep them safe.\n\n${v.url}` }),
    uz: (v) => ({ subject: `Fayllar o'chirilishiga ${v.days} kun qoldi`, text: `${v.date} kuni limitdan ortiq fayllar butunlay o'chiriladi. Ularni saqlab qolish uchun tarifni oshiring yoki fayllarni o'chiring.\n\n${v.url}` }),
    ru: (v) => ({ subject: `До удаления файлов: ${v.days} дн.`, text: `${v.date} файлы сверх квоты будут удалены навсегда. Повысьте тариф или удалите файлы.\n\n${v.url}` }),
  },
  purged: {
    en: (v) => ({ subject: 'Some MaxCloud files were deleted', text: `${v.count} file(s) (${v.bytes}) above your quota were deleted. Your account is active again.` }),
    uz: (v) => ({ subject: 'Ba\'zi MaxCloud fayllari o\'chirildi', text: `Limitdan ortiq ${v.count} ta fayl (${v.bytes}) o'chirildi. Hisobingiz yana faol.` }),
    ru: (v) => ({ subject: 'Часть файлов MaxCloud удалена', text: `Удалено файлов сверх квоты: ${v.count} (${v.bytes}). Аккаунт снова активен.` }),
  },
  payment_failed: {
    en: (v) => ({ subject: 'Payment failed for MaxCloud', text: `We couldn't charge your card for ${v.plan}. Update your payment method by ${v.date} to keep your storage.\n\n${v.url}` }),
    uz: (v) => ({ subject: 'MaxCloud to\'lovi amalga oshmadi', text: `${v.plan} uchun to'lov o'tmadi. Xotirangizni saqlab qolish uchun ${v.date} gacha to'lov usulini yangilang.\n\n${v.url}` }),
    ru: (v) => ({ subject: 'Не удалось списать оплату MaxCloud', text: `Не удалось оплатить ${v.plan}. Обновите способ оплаты до ${v.date}, чтобы сохранить хранилище.\n\n${v.url}` }),
  },
  renewal_reminder: {
    en: (v) => ({ subject: 'Your MaxCloud plan ends soon', text: `Your ${v.plan} plan ends on ${v.date}. Renew to keep your storage.\n\n${v.url}` }),
    uz: (v) => ({ subject: 'MaxCloud tarifingiz tugayapti', text: `${v.plan} tarifingiz ${v.date} kuni tugaydi. Xotirani saqlab qolish uchun uzaytiring.\n\n${v.url}` }),
    ru: (v) => ({ subject: 'Тариф MaxCloud скоро закончится', text: `Тариф ${v.plan} заканчивается ${v.date}. Продлите, чтобы сохранить хранилище.\n\n${v.url}` }),
  },
  folder_shared: {
    en: (v) => ({ subject: `${v.from} shared "${v.folder}" with you`, text: `${v.from} shared the folder "${v.folder}" with you (${v.role}).\n\n${v.url}` }),
    uz: (v) => ({ subject: `${v.from} siz bilan "${v.folder}" papkasini ulashdi`, text: `${v.from} siz bilan "${v.folder}" papkasini ulashdi (${v.role}).\n\n${v.url}` }),
    ru: (v) => ({ subject: `${v.from} открыл(а) вам папку «${v.folder}»`, text: `${v.from} открыл(а) вам папку «${v.folder}» (${v.role}).\n\n${v.url}` }),
  },
};

export function render(id: TemplateId, locale: string, vars: Vars): Rendered {
  const l = (['uz', 'ru', 'en'].includes(locale) ? locale : 'en') as Locale;
  return T[id][l](vars);
}
