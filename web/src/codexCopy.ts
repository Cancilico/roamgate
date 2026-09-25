import type { Terminal } from "@xterm/xterm";

type Screen = Pick<Terminal, "buffer" | "rows">;

function recentScreenText(terminal: Screen): string {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  const lines: string[] = [];
  for (let row = Math.max(0, end - 40); row < end; row++) {
    const line = buffer.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function codexCopyPickerVisible(terminal: Screen): boolean {
  const text = recentScreenText(terminal);
  return (
    /Copy (?:to clipboard|from response)/i.test(text) &&
    /(?:Whole response|enter (?:select|to confirm))/i.test(text)
  );
}

export function codexCopyConfirmed(terminal: Screen): boolean {
  return /Copied .{1,120} to clipboard/i.test(recentScreenText(terminal));
}
