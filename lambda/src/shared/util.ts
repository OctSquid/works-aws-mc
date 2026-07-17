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

/** timestamp の新しい順にソートした新しい配列を返す */
export function sortLatestFirst<T>(
  items: readonly T[],
  timestampOf: (item: T) => Date | undefined,
): T[] {
  return [...items].sort(
    (a, b) => (timestampOf(b)?.getTime() ?? 0) - (timestampOf(a)?.getTime() ?? 0),
  );
}
