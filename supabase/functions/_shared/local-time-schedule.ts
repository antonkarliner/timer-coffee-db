export interface LocalScheduleFields {
  deliver_local_date?: string | null;
  deliver_local_time?: string | null;
  local_time_fallback?: string;
  audience?: string;
  recurrence?: string;
  schedule_at?: unknown;
}
export function localScheduleError(fields: LocalScheduleFields): string | null {
  const date = fields.deliver_local_date;
  const time = fields.deliver_local_time;
  if ((date != null) !== (time != null)) {
    return "Local date and time must both be set";
  }
  if (date == null || time == null) return null;
  if (fields.audience !== "broadcast") {
    return "Local-time delivery requires broadcast audience";
  }
  if (fields.recurrence !== undefined && fields.recurrence !== "none") {
    return "Local-time recurrence is not supported";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Invalid local date";
  const instant = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  ) return "Invalid local date";
  // API uses HH:MM; stored PostgreSQL time includes seconds.
  if (!/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(time)) {
    return "Invalid local time";
  }
  return null;
}
export function defaultLocalScheduleAt(date: string, time: string): Date {
  return new Date(`${date}T${time.slice(0, 5)}:00Z`);
}
