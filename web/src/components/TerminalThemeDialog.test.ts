import { expect, spyOn, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalThemeDialog } from "./TerminalThemeDialog";
import { PopoverContent } from "./ui/popover";

function renderFontSearch(search: string, installedFonts: string[] | null) {
  // Seed the dialog's draft/delete state and the picker's open/search/list state.
  const state = spyOn(React, "useState")
    .mockImplementationOnce(() => [null, () => {}])
    .mockImplementationOnce(() => [null, () => {}])
    .mockImplementationOnce(() => [true, () => {}])
    .mockImplementationOnce(() => [search, () => {}])
    .mockImplementationOnce(() => [installedFonts, () => {}]);
  // SSR cannot mount the portal; render its real command contents inline.
  const content = spyOn(
    PopoverContent as typeof PopoverContent & {
      render: (
        props: React.ComponentProps<typeof PopoverContent>,
      ) => React.ReactNode;
    },
    "render",
  ).mockImplementation((props) => props.children);
  try {
    return renderToStaticMarkup(
      React.createElement(TerminalThemeDialog, {
        open: true,
        selection: { dark: "herdr-dark", light: "herdr-light" },
        customThemes: [],
        fontName: "Custom Mono",
        fontScale: 100,
        onSelectionChange: () => {},
        onCustomThemesChange: () => {},
        onFontNameChange: () => {},
        onFontScaleChange: () => {},
        onClose: () => {},
      }),
    );
  } finally {
    content.mockRestore();
    state.mockRestore();
  }
}

test("searching the current custom font keeps a candidate without font access", () => {
  for (const installedFonts of [null, [], ["Other Mono"]]) {
    const markup = renderFontSearch("Custom Mono", installedFonts);
    expect(markup).toContain("Use &quot;Custom Mono&quot;");
  }
});

test("only an installed font entry suppresses the typed candidate, ignoring case", () => {
  const markup = renderFontSearch("custom mono", ["Custom Mono"]);
  expect(markup).not.toContain("Use &quot;custom mono&quot;");
  expect(markup).toContain(
    'style="font-family:&quot;Custom Mono&quot;">Custom Mono</span>',
  );
});
