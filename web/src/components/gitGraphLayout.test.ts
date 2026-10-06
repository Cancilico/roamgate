import { describe, expect, test } from "bun:test";
import type { HistoryCommit } from "../../../shared/gitHistory";
import { graphRows, graphWindow } from "./gitGraphLayout";
const commit = (oid: string, parents: string[] = []): HistoryCommit => ({
  oid,
  parents,
  author: "A",
  date: "2026-01-01",
  subject: oid,
});
describe("Git graph rendering", () => {
  test("connects split branches, merges and roots without overlapping commit nodes", () => {
    const rows = graphRows([
      commit("merge", ["main", "feature"]),
      commit("main", ["root"]),
      commit("feature", ["root"]),
      commit("root"),
    ]);
    expect(rows[0]!.below.map((edge) => edge.to)).toEqual([0, 1]);
    expect(rows[2]!.lane).toBe(1);
    expect(
      rows[2]!.below.some((edge) => edge.from === 1 && edge.to === 0),
    ).toBe(true);
    expect(rows[3]!.below).toEqual([]);
    for (let i = 0; i < rows.length - 1; i++) {
      const lower = rows[i]!.below.map((edge) => edge.to).sort();
      const upper = rows[i + 1]!.above.map((edge) => edge.from).sort();
      expect([...new Set(lower)]).toEqual(upper);
    }
  });
  test("appending another history page preserves existing lane geometry", () => {
    const commits = Array.from({ length: 450 }, (_, i) =>
      commit(String(i), i === 449 ? [] : [String(i + 1)]),
    );
    const initial = graphRows(commits.slice(0, 200));
    const full = graphRows(commits);
    expect(full.slice(0, 200)).toEqual(initial);
    expect(full[199]!.below).toEqual(full[200]!.above);
  });
  test("virtualizes a deep scroll and keeps the rendered window bounded", () => {
    const window = graphWindow(40000, 800, 10000);
    expect(window.start).toBe(988);
    expect(window.end - window.start).toBe(44);
    expect(graphWindow(0, 400, 0)).toEqual({ start: 0, end: 0 });
  });
  test("supports disconnected histories, octopus merges and slot reuse", () => {
    const rows = graphRows([
      commit("merge", ["a", "b", "c"]),
      commit("a"),
      commit("b"),
      commit("c"),
      commit("other"),
    ]);
    expect(rows[0]!.width).toBe(3);
    expect(rows[4]!.lane).toBe(0);
  });
});
