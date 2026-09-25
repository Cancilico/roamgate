import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { codexCopyConfirmed, codexCopyPickerVisible } from "./codexCopy";

function screen(lines: string[]): Pick<Terminal, "buffer" | "rows"> {
  return {
    rows: lines.length,
    buffer: {
      active: {
        baseY: 0,
        length: lines.length,
        getLine: (row: number) => ({
          translateToString: () => lines[row],
        }),
      },
    },
  } as unknown as Pick<Terminal, "buffer" | "rows">;
}

test("recognizes the Codex copy picker and its completed confirmation", () => {
  expect(
    codexCopyPickerVisible(
      screen([
        "Copy to clipboard",
        "› 1. Whole response  clipboard probe",
        "enter select · esc back",
      ]),
    ),
  ).toBe(true);
  expect(
    codexCopyConfirmed(screen(["• Copied Whole response to clipboard"])),
  ).toBe(true);
  expect(
    codexCopyPickerVisible(screen(["Copy to clipboard", "other dialog"])),
  ).toBe(false);
  expect(codexCopyConfirmed(screen(["Copied to clipboard"]))).toBe(false);
});
