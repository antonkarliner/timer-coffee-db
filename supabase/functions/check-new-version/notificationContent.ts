// supabase/functions/check-new-version/notificationContent.ts
export const UPDATE_NOTIFICATION_TITLE = "Timer Coffee";
export const UPDATE_NOTIFICATION_BODY_BY_LOCALE = {
  en: "New version is out! Press to update ☕️",
  ar: "تم إصدار النسخة الجديدة! اضغط للتحديث ☕️",
  de: "Neue Version ist da! Tippen zum Aktualisieren ☕️",
  el: "Νέα έκδοση διαθέσιμη! Πατήστε για ενημέρωση ☕️",
  es: "¡Nueva versión disponible! Toca para actualizar ☕️",
  fa: "نسخه جدید منتشر شد! برای به‌روزرسانی لمس کنید ☕️",
  fi: "Uusi versio on saatavilla! Päivitä napauttamalla ☕️",
  fr: "Nouvelle version disponible ! Appuyez pour mettre à jour ☕️",
  hr: "Nova verzija je dostupna! Dodirnite za ažuriranje ☕️",
  id: "Versi baru telah keluar! Ketuk untuk memperbarui ☕️",
  it: "Nuova versione disponibile! Tocca per aggiornare ☕️",
  ja: "新しいバージョンが登場！タップして更新 ☕️",
  ko: "새 버전이 출시되었습니다! 업데이트하려면 탭하세요 ☕️",
  nl: "Nieuwe versie is uit! Tik om bij te werken ☕️",
  no: "Ny versjon er ute! Trykk for å oppdatere ☕️",
  pl: "Nowa wersja jest dostępna! Naciśnij, aby zaktualizować ☕️",
  pt: "Nova versão disponível! Toque para atualizar ☕️",
  ro: "Noua versiune este disponibilă! Atinge pentru a actualiza ☕️",
  ru: "Вышла новая версия! Нажмите, чтобы обновить ☕️",
  tr: "Yeni sürüm çıktı! Güncellemek için dokunun ☕️",
  uk: "Вийшла нова версія! Натисніть, щоб оновити ☕️",
  zh: "新版本已发布！点击更新 ☕️"
};
export function getStoreUrl(platform) {
  return platform === "ios" ? "https://apps.apple.com/app/timer-coffee/id6449322787" : "https://play.google.com/store/apps/details?id=com.coffee.timer";
}
export function resolveUpdateNotificationLocale(input) {
  const normalized = (input ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "en";
  if (UPDATE_NOTIFICATION_BODY_BY_LOCALE[normalized]) return normalized;
  const base = normalized.split("-")[0];
  if (base && UPDATE_NOTIFICATION_BODY_BY_LOCALE[base]) return base;
  return "en";
}
