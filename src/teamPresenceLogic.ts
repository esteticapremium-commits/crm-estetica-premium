export const PRESENCE_IDLE_MS = 5 * 60_000;
export function isPresenceActive(visible: boolean, focused: boolean, lastInteraction: number, now: number) {
  return visible && focused && now >= lastInteraction && now - lastInteraction < PRESENCE_IDLE_MS;
}
export function presenceDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
