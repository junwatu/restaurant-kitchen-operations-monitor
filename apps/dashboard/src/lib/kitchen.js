export async function api(path, payload) {
  const res = await fetch(path, {
    ...(payload
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
    signal: AbortSignal.timeout(35000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Ticket timing thresholds, in minutes. A ticket is "warn" from WARN_MIN and "late" from LATE_MIN.
export const WARN_MIN = 10;
export const LATE_MIN = 20;

export const ZONES = ['Grill', 'Fry', 'Pass'];
export const QUICK_DISHES = ['BURGER', 'FRIES', 'RAMEN', 'SALAD', 'PASTA', 'STEAK'];

export const fmtTime = v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function elapsedMs(from, now) {
  return Math.max(0, now - new Date(from).getTime());
}

export function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function urgency(ms) {
  const min = ms / 60000;
  if (min >= LATE_MIN) return 'late';
  if (min >= WARN_MIN) return 'warn';
  return 'ok';
}

export function fmtAgo(v, now) {
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return fmtTime(v);
}

// Emoji for the dish name before the "-<number>" suffix; unknown dishes get a plate.
const DISH_EMOJI = { BURGER: '🍔', FRIES: '🍟', RAMEN: '🍜', SALAD: '🥗', PASTA: '🍝', STEAK: '🥩' };
export const dishEmoji = tag => DISH_EMOJI[String(tag).split('-')[0].trim()] ?? '🍽️';
