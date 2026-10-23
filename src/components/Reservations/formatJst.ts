/** "2026-10-15T09:00+09:00" -> "2026/10/15 09:00 JST" */
export const formatJst = (key: string): string => `${key.slice(0, 10).replaceAll("-", "/")} ${key.slice(11, 16)} JST`;
