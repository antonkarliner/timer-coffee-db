// supabase/functions/check-new-version/notificationContent.ts

export type UpdatePlatform = "ios" | "android";

export const UPDATE_NOTIFICATION_TITLE = "Timer Coffee";

export const UPDATE_NOTIFICATION_BODY_BY_LOCALE: Record<string, string> = {
  en: "New version is out! Press to update ☕️",
  ar: "تم إصدار النسخة الجديدة! اضغط للتحديث ☕️",
  de: "Neue Version ist da! Tippen zum Aktualisieren ☕️",
  es: "¡Nueva versión disponible! Toca para actualizar ☕️",
  fr: "Nouvelle version disponible ! Appuyez pour mettre à jour ☕️",
  id: "Versi baru telah keluar! Ketuk untuk memperbarui ☕️",
  it: "Nuova versione disponibile! Tocca per aggiornare ☕️",
  ja: "新しいバージョンが登場！タップして更新 ☕️",
  nl: "Nieuwe versie is uit! Tik om bij te werken ☕️",
  pl: "Nowa wersja jest dostępna! Naciśnij, aby zaktualizować ☕️",
  pt: "Nova versão disponível! Toque para atualizar ☕️",
  ro: "Noua versiune este disponibilă! Atinge pentru a actualiza ☕️",
  ru: "Вышла новая версия! Нажмите, чтобы обновить ☕️",
  tr: "Yeni sürüm çıktı! Güncellemek için dokunun ☕️",
  uk: "Вийшла нова версія! Натисніть, щоб оновити ☕️",
  zh: "新版本已发布！点击更新 ☕️",
};

export function getStoreUrl(platform: UpdatePlatform): string {
  return platform === "ios"
    ? "https://apps.apple.com/app/timer-coffee/id6449322787"
    : "https://play.google.com/store/apps/details?id=com.coffee.timer";
}

export function resolveUpdateNotificationLocale(
  input: string | null | undefined,
): string {
  const normalized = (input ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "en";

  if (UPDATE_NOTIFICATION_BODY_BY_LOCALE[normalized]) return normalized;

  const base = normalized.split("-")[0];
  if (base && UPDATE_NOTIFICATION_BODY_BY_LOCALE[base]) return base;

  return "en";
}
