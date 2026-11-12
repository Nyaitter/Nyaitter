'use strict';

// 置換時のテーブル削除順を、実際のDBの外部キー関係から決める。
//
// 背景: 「スナップショットに含まれるテーブルだけ DELETE すれば安全」ではない。
// users / posts / groups を消すと ON DELETE CASCADE で **スナップショットに
// 含まれないテーブル**（例: community_notes、polls）の行まで消える。
// 参照先が消えるテーブルの行を先に削除し、そのうえで含まれるテーブルを
// 依存順（親→子）で削除する。

// edges: [{ child, parent }] の配列（child は parent を参照している）。
// targets: この置換で DELETE するテーブル（含まれないテーブルのうち、宛先に存在するもの）。
function orderDeletions(targets, edges) {
  const inSet = new Set(targets);
  // 親 → 子（参照している側）への辺だけを使う。
  const childrenByParent = new Map();
  const childParents = new Map();
  for (const table of inSet) { childrenByParent.set(table, new Set()); childParents.set(table, new Set()); }
  for (const edge of edges) {
    if (!inSet.has(edge.child) || !inSet.has(edge.parent) || edge.child === edge.parent) continue;
    if (childrenByParent.get(edge.parent).has(edge.child)) continue;
    childrenByParent.get(edge.parent).add(edge.child);
    childParents.get(edge.child).add(edge.parent);
  }
  // 親（参照される側）から順に並べる: 親が全部済んだ子だけを次に出す。
  const pending = new Map([...childParents].map(([table, parents]) => [table, parents.size]));
  const ready = targets.filter((table) => pending.get(table) === 0);
  const parentFirst = [];
  while (ready.length) {
    const table = ready.shift();
    parentFirst.push(table);
    for (const child of childrenByParent.get(table)) {
      pending.set(child, pending.get(child) - 1);
      if (pending.get(child) === 0) ready.push(child);
    }
  }
  // 循環参照などで残ったものは決定的な順序で末尾へ回す。
  const leftovers = targets.filter((table) => !parentFirst.includes(table)).sort();
  // SQLite は文ごとに外部キーを即時検査するので、子から先に消す（親First の逆順）。
  return { parentFirst: [...parentFirst, ...leftovers], deleteOrder: [...leftovers, ...parentFirst].reverse() };
}

// スナップショットに含まれないテーブルをここで消すのは「置換で親行が消える」場合だけ。
// 参照されていないテーブル（例: 独立した新機能表）は触らずに残す。
function tablesToClear(includedSet, availableTables, edges, { scope = null } = {}) {
  const scoped = (table) => (scope ? scope.includes(table) : availableTables.includes(table));
  const clear = new Set();
  const includedTables = new Set(availableTables.filter((table) => includedSet.has(table) && scoped(table)));
  // 置換で親行が消えるテーブルから、CASCADE で連鎖して消える子を辿る。
  const stack = [...includedTables];
  while (stack.length) {
    const parent = stack.pop();
    for (const edge of edges) {
      if (edge.parent !== parent || edge.child === edge.parent) continue;
      // SET NULL / RESTRICT 等の辺は行を消さない（NULL 化されるか削除自体が
      // DB に拒否される）。CASCADE の辺だけが連鎖削除になる。
      if (typeof edge.onDelete === 'string' && edge.onDelete.toUpperCase() !== 'CASCADE') continue;
      if (includedTables.has(edge.child)) continue;
      if (!availableTables.includes(edge.child) || !scoped(edge.child)) continue;
      if (clear.has(edge.child)) continue;
      clear.add(edge.child);
      stack.push(edge.child);
    }
  }
  return [...clear];
}

module.exports = { orderDeletions, tablesToClear };
