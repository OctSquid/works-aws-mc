/** 汎用の小物ユーティリティ */

/** timestamp が最新の要素を返す（undefined の timestamp は最古扱い） */
export function latestBy<T>(
  items: readonly T[],
  timestampOf: (item: T) => Date | undefined,
): T | undefined {
  let latest: T | undefined;
  let latestMs = -Infinity;
  for (const item of items) {
    const ms = timestampOf(item)?.getTime() ?? -Infinity;
    if (latest === undefined || ms > latestMs) {
      latest = item;
      latestMs = ms;
    }
  }
  return latest;
}

/**
 * POSIX シェルの単一引数として安全にクォートする。
 * 単一クォート内は一切の展開が起きないため、`'` を `'\''` に置換すれば完全。
 */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** 上限を超えたら末尾（最新側）を優先して切り詰める。切り詰め時は先頭に印を付ける */
export function truncateTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const marker = "…(切り詰め)\n";
  return marker + text.slice(text.length - (maxLength - marker.length));
}

/** timestamp の新しい順にソートした新しい配列を返す */
export function sortLatestFirst<T>(
  items: readonly T[],
  timestampOf: (item: T) => Date | undefined,
): T[] {
  return [...items].sort(
    (a, b) => (timestampOf(b)?.getTime() ?? 0) - (timestampOf(a)?.getTime() ?? 0),
  );
}
