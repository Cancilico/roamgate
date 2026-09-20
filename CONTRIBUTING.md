# Contributing

## Development Setup

1. Install Bun 1.4.1 or newer (CI uses 1.4.1) and start a local Herdr server.
2. From the repository root, run `bun install --frozen-lockfile`.
3. Run these in separate terminals, then open <http://localhost:5173>:

   ```bash
   bun run dev:server
   bun run dev:web
   ```

The development bridge binds to `127.0.0.1:8788`; Vite proxies `/api`, `/ws`,
and `/login` there. Installed services and `bun run start:server` retain port
8787 by default.

Keep `bun.lock` (the only lockfile) and shared tools (TypeScript, Bun types,
formatting/linting) at root; browser/Vite dependencies in `web/package.json`;
server runtime dependencies in `server/package.json`. After dependency changes,
run root `bun install` and commit manifests/lockfile.

## Validation

**Fresh checkout:** install dependencies, then `bun run typecheck` to build
web assets required by process tests.

| During iteration | Command / limits |
| --- | --- |
| Formatting | `bun run format <paths...>` formats only those files or directories; `bun run format:check <paths...>` checks them without writing. Omit paths to process the whole repository. |
| Types | `bun run typecheck:quick` checks root scripts, web, and server without rebuilding assets or validating production bundles. |
| Lint | `bun run lint` caches unchanged content in `node_modules/.cache/eslint/`. Use `bun run lint --no-cache` for fresh checks after tooling/dependency updates. |
| Related tests | `bun test <path>` or `bun run test:quick` (four parallel workers; includes integration tests, excludes Chrome-based browser regressions). |
| Browser regressions | `bun run test:browser` runs serially; Chrome-backed cases require Chrome/Chromium or `CHROME_BIN`, otherwise they skip. The setup-card test also runs in system WebKit on macOS. |
| Submission | `bun run precommit` runs formatting, lint, full typechecks, and the full test suite. Quick checks do not replace it. |

Pull-request CI runs formatting, lint, type checks, the site build, and
`test:quick`. Browser regressions are optional: in GitHub Actions, select **CI**,
choose **Run workflow**, select the branch, and enable **Run browser regressions**.
The browser suite runs as a separate job. `bun run test` and the local pre-commit
gate retain the full serial suite.

Run `bun run install-hooks` once per clone to point Git at the tracked
`.githooks/` directory; its `pre-commit` hook runs `bun run precommit`.

1. During edits, format the touched paths and run related tests with
   `bun test <path>`. Use `typecheck:quick` or `test:quick` for broader feedback.
2. Before submission, validate the final revision with the full `precommit`
   gate. When committing with the installed hook, let the hook run it rather
   than manually running the same gate immediately before `git commit`.
3. Without the hook, run `bun run precommit` before committing. Rerun checks
   after further edits; do not bypass the gate or treat quick checks as a pass.

For a specific browser fixture, filter the existing tests instead of running
all browser regressions, for example:

```bash
bun test web/src/uiScale.test.ts --test-name-pattern terminalLinks
```

Browser harnesses share bounded waits and process teardown in
`web/src/browserChrome.ts`. Wait for a ready condition or render boundary instead
of a fixed settling delay; retain timed observation windows when testing long
presses, cancellation, or repeated events. Focused runs do not replace the full
gate. The setup-card harness uses `Bun.WebView` with ephemeral storage and never
connects to an existing user Chrome session.

Workspace checks: `bun run --filter roamgate-web typecheck` and
`bun run --filter roamgate-server typecheck` (builds web assets first).

Frontend changes: `bun run build:web`. Production assets/bundling: `bun run build`.
Releases: package and inspect every supported archive/checksum; see
[build commands](docs/DEPLOYMENT.md#build-a-standalone-executable) and
[release policy](AGENTS.md#release-notes).

## Style Organization

Global styling is split by responsibility; there is no monolithic stylesheet.

- `web/src/styles/tokens.css`: theme variables only (`:root`, `data-theme`,
  `data-accent` selectors).
- `web/src/styles/base.css`: element resets and shared primitives (`.modal`,
  `.form-field`, `.badge`, `.status-*`, `.git-*`, `.panel*`, loading states).
  Styles used by several unrelated components belong here, not in one
  component's file.
- `web/src/styles/vendor.css`: shared syntax highlighting and diff renderer
  overrides. Consumer-specific library overrides live with their components.
- `web/src/styles/layout/*.css`: app-shell regions (`app`, `topbar`,
  `sidebar`, `toast`, `mobile-nav`), imported once by `App.tsx`.
- `web/src/components/<Name>.css`: styles for one component, imported by that
  component (`import "./<Name>.css"`) and deleted together with it. The same
  pattern applies to `web/src/components/ui/` primitives.

Keep class names prefixed with the component name (for example
`.agent-history-card-title`) so selectors stay searchable and collision-free.
Media queries (including mobile adaptations) live in the owning file next to
the rules they adjust; do not create a separate mobile stylesheet.

App shell and Suspense fallback styles must load before the lazy content they
surround: use `styles/base.css` or `styles/layout/`. Styles shared across
independently loaded features belong in a shared stylesheet imported by each
consumer, or in `styles/base.css` when needed globally. A feature's components
may share co-located CSS when their explicit static imports guarantee it loads
on every rendering path; do not rely on an unrelated feature being opened.

## Pages Website and Tutorial

Edit `site/` for the landing page; **only `docs/TUTORIAL.md`** for tutorial text.
`scripts/build-pages.ts` renders into `site/tutorial/index.html`, rewrites
screenshots/references, and checks built-site links/fragments.

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` locally and check `/tutorial/`, narrow screens, keyboard
navigation, and JavaScript-disabled reading. Production canonical URLs, social
images, and the sitemap use <https://roamgate.dev/>. Do not commit `.pages-dist/`.

**Deploy Pages** runs on pushes to `main` (including merged PRs); manual dispatch
remains available for retries. Both require a published Roamgate release as GitHub
Latest: the live installer probe blocks upload on missing assets, HTTP errors,
or network failures. Source builds do not qualify. After repository renames,
align the site's installer URL and workflow probe.

## Pull Requests

Use focused commits and short imperative messages. PR descriptions should cover
behavior, verification, and compatibility impact. For UI changes, upload
screenshots as GitHub attachments and embed them in the PR description. Do not
commit screenshot files to the repository solely for PR review. Do not commit
generated assets (`dist/`, `server/public/`) or binaries.

Unlabeled PRs get `documentation` (docs-only), `dependencies` (dependency updates),
`bug` (fix titles), or `enhancement` (other code). Release preparation gets
`skip-changelog`. Override with a `.github/release.yml` category before merging.

Contributions are licensed under MIT.
