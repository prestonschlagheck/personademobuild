// Time formats shared by the phone and the state panel, in English to match the rest of the chrome.
const clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "9:41 PM". */
export const clockTime = (iso: string) => clockFormat.format(new Date(iso));

/** A call length the way iOS shows it: 0:07, 12:34, 1:02:03. */
export function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}
