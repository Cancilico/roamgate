import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import {
  codexCopyConfirmation,
  codexCopyCompleted,
  codexCopyConfirmed,
  codexCopyPickerVisible,
  codexSelectionCopyVisible,
} from "./codexCopy";

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

test("recognizes Codex native selection copy confirmations", () => {
  expect(
    codexCopyConfirmation(screen(["Copied 280 chars to host clipboard"])),
  ).toBe("Copied 280 chars to host clipboard");
  expect(
    codexCopyConfirmed(screen(["Copied 280 chars to host clipboard"])),
  ).toBe(true);
  expect(
    codexCopyConfirmation(
      screen([
        "280 chars selected",
        "^c copy · enter copy & follow · esc clear",
      ]),
    ),
  ).toBeNull();
});

test("recognizes the native selection copy shortcuts only while selecting", () => {
  expect(
    codexSelectionCopyVisible(
      screen(["^c copy · enter copy & follow · esc clear"]),
    ),
  ).toBe(true);
  expect(codexSelectionCopyVisible(screen(["esc to interrupt"]))).toBe(false);
});

test("does not treat quoted terminal output as a completed copy", () => {
  expect(
    codexCopyConfirmation(
      screen(['console.log("Copied 280 chars to host clipboard")']),
    ),
  ).toBeNull();
});

test("repeated selection copies finish when the selection controls disappear", () => {
  const confirmation = "Copied 104 chars to host clipboard";
  const selecting = screen([
    confirmation,
    "^c copy · enter copy & follow · esc clear",
  ]);
  const completed = screen([confirmation, "? shortcuts"]);
  expect(codexCopyCompleted(selecting, confirmation, true, false)).toBe(false);
  expect(codexCopyCompleted(completed, confirmation, true, false)).toBe(true);
  expect(codexCopyCompleted(completed, confirmation, false, false)).toBe(false);
  expect(codexCopyCompleted(completed, null, false, false)).toBe(true);
});

test("repeated picker copies finish only after confirming the picker", () => {
  const confirmation = "Copied Whole response to clipboard";
  const picking = screen([
    confirmation,
    "Copy to clipboard",
    "Whole response",
    "enter select",
  ]);
  expect(codexCopyCompleted(picking, confirmation, false, true)).toBe(false);
  expect(
    codexCopyCompleted(screen([confirmation]), confirmation, false, true),
  ).toBe(true);
});
