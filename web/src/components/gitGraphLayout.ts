import type { HistoryCommit } from "../../../shared/gitHistory";
export interface GraphEdge {
  from: number;
  to: number;
  color: number;
}
export interface GraphRow {
  lane: number;
  color: number;
  above: GraphEdge[];
  below: GraphEdge[];
  width: number;
}
interface Lane {
  oid: string;
  color: number;
}
/** Stable slots make edges join exactly at row and page boundaries. */
export function graphRows(commits: readonly HistoryCommit[]): GraphRow[] {
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  return commits.map((commit) => {
    let lane = lanes.findIndex((item) => item?.oid === commit.oid);
    const introduced = lane < 0;
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = { oid: commit.oid, color: nextColor++ };
    }
    const color = lanes[lane]!.color;
    const above = lanes.flatMap((item, index) =>
      item && !(introduced && index === lane)
        ? [{ from: index, to: index, color: item.color }]
        : [],
    );
    lanes[lane] = null;
    const below: GraphEdge[] = [];
    for (const [parentIndex, parent] of commit.parents.entries()) {
      let target = lanes.findIndex((item) => item?.oid === parent);
      if (target < 0) {
        target = parentIndex === 0 ? lane : lanes.indexOf(null);
        if (target < 0) target = lanes.length;
        lanes[target] = {
          oid: parent,
          color: parentIndex === 0 ? color : nextColor++,
        };
      }
      below.push({ from: lane, to: target, color: lanes[target]!.color });
    }
    lanes.forEach((item, index) => {
      if (item && !below.some((edge) => edge.to === index))
        below.push({ from: index, to: index, color: item.color });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return {
      lane,
      color,
      above,
      below,
      width: Math.max(
        lane + 1,
        ...above.map((edge) => edge.from + 1),
        ...below.map((edge) => edge.to + 1),
      ),
    };
  });
}
export const GRAPH_ROW_HEIGHT = 40;
export function graphWindow(scrollTop: number, height: number, count: number) {
  const start = Math.max(0, Math.floor(scrollTop / GRAPH_ROW_HEIGHT) - 12);
  return {
    start: Math.min(start, count),
    end: Math.min(
      count,
      Math.ceil((scrollTop + height) / GRAPH_ROW_HEIGHT) + 12,
    ),
  };
}
