/** UI choices translate into the same digest-bound schedules as the CLI. */
import { parseSchedule, scheduleText, validTimezone, type Schedule } from "./flow-schedule.js";

export function composerSchedule(fields: URLSearchParams): { ok: true; schedule: string | null } | { ok: false; message: string } {
  const repeat = fields.get("repeat") ?? "once";
  if (repeat === "once") return { ok: true, schedule: null };
  if (!["daily", "weekly", "custom"].includes(repeat)) return { ok: false, message: "Choose how often this task repeats." };
  if (repeat === "custom") {
    const count = Number(fields.get("interval"));
    const unit = fields.get("interval-unit");
    const multiplier = unit === "minutes" ? 1 : unit === "hours" ? 60 : unit === "days" ? 1440 : 0;
    if (!Number.isInteger(count) || count < 1 || multiplier === 0 || parseSchedule(`every:${count * multiplier}`) === null) return { ok: false, message: "Choose an interval between 5 minutes and 7 days." };
    return { ok: true, schedule: `every:${count * multiplier}` };
  }
  const time = fields.get("time") ?? "";
  const timezone = fields.get("timezone") ?? "UTC";
  if (!validTimezone(timezone)) return { ok: false, message: "Choose a valid timezone." };
  const text = `${repeat === "weekly" ? `weekly:${fields.get("weekday") ?? ""}` : "daily"}:${time}@${timezone}`;
  const schedule = parseSchedule(text);
  return schedule === null ? { ok: false, message: "Choose a valid time and day for this task." } : { ok: true, schedule: scheduleText(schedule) };
}

export function scheduleFields(schedule: Schedule): Record<string, string> {
  if (schedule.kind === "every") {
    const unit = schedule.minutes % 1440 === 0 ? "days" : schedule.minutes % 60 === 0 ? "hours" : "minutes";
    return { repeat: "custom", interval: String(schedule.minutes / (unit === "days" ? 1440 : unit === "hours" ? 60 : 1)), "interval-unit": unit };
  }
  return { repeat: schedule.kind, time: schedule.hhmm, timezone: schedule.timezone ?? "UTC", ...(schedule.kind === "weekly" ? { weekday: String(schedule.day) } : {}) };
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
/** A normal form works without JavaScript; enhancement only folds unused fields. */
export function scheduleEditorHtml(raw: string | null, submitted?: URLSearchParams): string {
  const parsed = raw === null ? null : parseSchedule(raw);
  const fields = submitted?.has("repeat") ? Object.fromEntries(submitted) : parsed === null ? {} : scheduleFields(parsed);
  const repeat = fields.repeat ?? "daily";
  const value = (name: string, fallback: string) => escape(fields[name] ?? fallback);
  return `<fieldset data-schedule-editor${raw === null && submitted === undefined ? ' data-detect-timezone="true"' : ""}><legend>When to run</legend>` +
    `<label>Repeat<select name="repeat">${[["daily", "Daily"], ["weekly", "Weekly"], ["custom", "Custom interval"]].map(([id, label]) => `<option value="${id}"${repeat === id ? " selected" : ""}>${label}</option>`).join("")}</select></label>` +
    `<div data-schedule-kind="weekly"><label>Day<select name="weekday">${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => `<option value="${index}"${String(index) === (fields.weekday ?? "1") ? " selected" : ""}>${day}</option>`).join("")}</select></label></div>` +
    `<div data-schedule-kind="calendar"><label>Time<input type="time" name="time" value="${value("time", "09:00")}"></label><label>Timezone<input type="text" name="timezone" value="${value("timezone", "UTC")}" autocomplete="off" placeholder="America/Los_Angeles"></label><p class="meta">Daily and weekly times follow this timezone. A skipped clock time skips that occurrence; a repeated time runs once.</p></div>` +
    `<div data-schedule-kind="custom"><label>Every<input type="number" name="interval" min="1" value="${value("interval", "60")}"></label><label>Unit<select name="interval-unit">${["minutes", "hours", "days"].map(unit => `<option${unit === (fields["interval-unit"] ?? "minutes") ? " selected" : ""}>${unit}</option>`).join("")}</select></label><p class="meta">Intervals range from 5 minutes to 7 days.</p></div></fieldset>`;
}

export function scheduleEditorScript(): string {
  return `(function(){document.querySelectorAll('[data-schedule-editor]').forEach(function(root){
    var repeat=root.querySelector('[name=repeat]'),zone=root.querySelector('[name=timezone]');
    if(root.dataset.detectTimezone==='true'){try{zone.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch(e){}}
    function update(){root.querySelectorAll('[data-schedule-kind]').forEach(function(group){var active=group.dataset.scheduleKind===repeat.value||(group.dataset.scheduleKind==='calendar'&&repeat.value!=='custom');group.hidden=!active;group.querySelectorAll('input,select').forEach(function(field){field.disabled=!active;});});}
    repeat.addEventListener('change',update);update();
  });})();`;
}
