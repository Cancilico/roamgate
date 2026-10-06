/** Read-only repository history contracts, shared by bridge and browser. */
export interface HistoryRef {
  name: string;
  oid: string;
}
export interface HistorySnapshot {
  tips: string[];
  refs: HistoryRef[];
  shallow: boolean;
}
export interface HistoryCommit {
  oid: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}
export interface HistoryPage {
  snapshot: HistorySnapshot;
  commits: HistoryCommit[];
  offset: number;
  next: number | null;
}
export interface HistorySearch {
  matches: { commit: HistoryCommit; offset: number }[];
  next: number | null;
}
export interface HistoryDetails extends HistoryCommit {
  body: string;
  committer: string;
}
export interface HistoryRange {
  base: string | null;
  target: string;
}
