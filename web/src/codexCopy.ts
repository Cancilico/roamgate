import type { Terminal } from "@xterm/xterm";

type Screen = Pick<Terminal, "buffer" | "rows">;

function recentScreenLines(terminal: Screen): string[] {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  const lines: string[] = [];
  for (let row = Math.max(0, end - 40); row < end; row++) {
    const line = buffer.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.map((line) => line.replace(/\s+/g, " ").trim());
}

export function codexCopyPickerVisible(terminal: Screen): boolean {
  const text = recentScreenLines(terminal).join(" ");
  return (
    /Copy (?:to clipboard|from response)/i.test(text) &&
    /(?:Whole response|enter (?:select|to confirm))/i.test(text)
  );
}

export function codexCopyConfirmation(terminal: Screen): string | null {
  return (
    recentScreenLines(terminal)
      .reverse()
      .find((line) =>
        /^(?:[\u2022\u25cf] )?Copied (?:\d+ chars to host clipboard|.{1,120}? to clipboard)\.?$/i.test(
          line,
        ),
      ) ?? null
  );
}

export function codexCopyConfirmed(terminal: Screen): boolean {
  return codexCopyConfirmation(terminal) !== null;
}

export function codexSelectionCopyVisible(terminal: Screen): boolean {
  return recentScreenLines(terminal).some((line) =>
    /\^c copy.*enter copy & follow.*esc clear$/i.test(line),
  );
}

export function codexCopyCompleted(
  terminal: Screen,
  previousConfirmation: string | null,
  selectionWasVisible: boolean,
  pickerWasVisible: boolean,
): boolean {
  if (codexCopyPickerVisible(terminal)) return false;
  const confirmation = codexCopyConfirmation(terminal);
  return (
    confirmation !== null &&
    (confirmation !== previousConfirmation ||
      pickerWasVisible ||
      (selectionWasVisible && !codexSelectionCopyVisible(terminal)))
  );
}
