import { expect, test } from "bun:test";
import { parentFilesystemPath } from "./filesystemPaths";
import {
  absolutePath,
  isWorkspaceRelativePath,
} from "./components/fileExplorerResources";

test("filesystem parents stop at POSIX, drive, and share roots", () => {
  for (const [path, parent] of [
    ["/home/user/docs", "/home/user"],
    ["/home/", "/"],
    ["/", "/"],
    ["C:\\docs\\reference", "C:/docs"],
    ["C:/docs", "C:/"],
    ["C:/", "C:/"],
    ["//server/share/docs", "//server/share"],
    ["//server/share", "//server/share"],
  ])
    expect(parentFilesystemPath(path!)).toBe(parent!);
});

test("copy paths do not prefix an absolute filesystem entry with the workspace", () => {
  expect(isWorkspaceRelativePath("/references/r.md")).toBe(false);
  expect(isWorkspaceRelativePath("C:/references/r.md")).toBe(false);
  expect(isWorkspaceRelativePath("docs/r.md")).toBe(true);
  const entry = {
    name: "r.md",
    path: "/references/r.md",
    type: "file" as const,
    size: 0,
    mtime_ms: 0,
    hidden: false,
  };
  expect(absolutePath("/workspace", entry)).toBe("/references/r.md");
  expect(absolutePath("/workspace", { ...entry, path: "docs/r.md" })).toBe(
    "/workspace/docs/r.md",
  );
});
