# End-to-End Tests (Playwright)

This repo ships an automated E2E harness for the extension using Playwright. It:

- Builds MV3 to `dist/` and launches Chromium with the extension loaded.
- Stubs `https://api.odysee.com/yt/resolve` for deterministic results.
- Navigates to YouTube watch/results pages to verify injected UI, overlays, and redirect behavior.
- Captures visual snapshots of the injected button for pixel checks.

## Prerequisites

- Node.js 18+
- One-time: install Playwright browsers

Windows/macOS:

```
npm install
npm run test:e2e:install
```

Linux:

```
npm install
npm run test:e2e:install
```

## Running

- Headed (recommended while iterating):

```
npm run test:e2e
```

- Headless:

```
npm run test:e2e:headless
```

Artifacts: `playwright-report/`, `test-results/` (videos, traces on failure).

### Summary + Recommendations

Run the suite and generate human-friendly summaries and recommendations:

```
npm run test:e2e:report
```

Outputs:

- `build/e2e-summary.md` — pass/fail breakdown with attachment links
- `build/e2e-recommendations.md` — prioritized suggestions based on failures
- `build/e2e-artifacts/` — screenshots captured at key checkpoints

### Stubs vs Real API

- By default, tests hit the real Odysee API. Some assertions will skip
  when a given YouTube video/channel is not mirrored on Odysee.
- To force deterministic mappings (recommended for CI gates):

```
npm run test:e2e:report:stubs
```

This sets `E2E_USE_STUBS=1` so background resolve calls always return results.

### Troubleshooting

- If Playwright install appears to hang, use the wrapper script which omits `--with-deps` outside Linux:
  - `npm run test:e2e:install`
- To install only Chromium (sufficient for this suite):
  - `npx playwright install chromium`
- Behind a proxy: set `HTTPS_PROXY`/`HTTP_PROXY` and retry install.

### Debugging

- Open Playwright Inspector:

```
npx playwright test -g "player control button appears" --debug
```

- Enable rich debug output and extra artifacts:

```
E2E_DEBUG=1 E2E_TRACE=on E2E_VIDEO=on E2E_SCREENSHOT=on npm run test:e2e
```

This streams page console logs, captures pre/post player diagnostics (`build/e2e-artifacts/player_*.{png,json}`), and keeps traces/videos.

- View last report:
  - `npx playwright show-report`
  - Open trace: `npx playwright show-trace test-results/<failed-test>/trace.zip`

### Visual snapshots

On first run, create baselines for visual assertions:

```
npx playwright test --update-snapshots
```

Subsequent runs will compare against those baselines.

## Notes

- The Odysee YT resolve API is stubbed; any requested `video_ids` or `channel_ids` map to synthetic Odysee paths, ensuring the extension always “finds” a target.
- Tests use a single persistent Chromium context so the MV3 service worker is reliably available. Extension ID is derived from the service worker URL.
- Visual snapshot targets only the extension button element (reduces flakiness from surrounding dynamic content).

## Firefox

Playwright does not support loading WebExtensions in Firefox directly. For FF coverage, wire `web-ext run` with remote debugging and drive via Selenium/GeckoDriver or Playwright’s experimental Juggler (out of scope here). The current suite focuses on Chromium where MV3 is well supported.
