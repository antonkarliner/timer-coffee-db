/** Base BCP-47 language subtag, e.g. "en-US" -> "en", "pt_BR" -> "pt". */
export function baseLang(locale: string): string {
  return locale.trim().toLowerCase().split(/[-_]/)[0];
}
