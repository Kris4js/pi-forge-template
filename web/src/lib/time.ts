/** "刚刚" / "3 分钟前" / "2 小时前", then a date for anything older than a day. */
export function relativeTime(iso: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
