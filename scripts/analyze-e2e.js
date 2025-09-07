/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')

const root = __dirname.replace(/\\/g, '/')
const repoRoot = path.resolve(root, '..')
const reportPath = path.join(repoRoot, 'build', 'playwright-report.json')
const artifactsDir = path.join(repoRoot, 'build', 'e2e-artifacts')

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

function summarize(report) {
  const tests = []
  function visitSuite(suite) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const r of test.results || []) {
          tests.push({
            title: spec.title,
            project: r.projectName || 'default',
            status: r.status,
            error: r.error,
            attachments: r.attachments || [],
            steps: r.steps || [],
          })
        }
      }
    }
    for (const child of suite.suites || []) visitSuite(child)
  }
  for (const s of report.suites || []) visitSuite(s)
  const counts = tests.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc }, {})
  return { tests, counts }
}

function linkify(p) {
  // Keep as relative path for IDEs
  return p.replace(/\\/g, '/').replace(repoRoot.replace(/\\/g, '/') + '/', '')
}

function analyze(tests) {
  const recs = []
  const add = (title, items) => recs.push({ title, items })

  const failed = tests.filter(t => t.status !== 'passed')

  for (const t of failed) {
    const name = t.title
    const att = t.attachments || []
    const imgs = att.filter(a => (a.path && a.path.endsWith('.png'))).map(a => linkify(a.path))
    const err = t.error?.message || ''
    if (/player control button/i.test(name)) {
      add('Player control button missing', [
        'Verify selector for control bar: `.ytp-right-controls` may vary.',
        'Ensure `buttonVideoPlayer` change triggers immediate re-render (storage listener).',
        'Check `mountPlayerButtonBefore` query in `src/settings/index.ts` for YouTube changes.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else if (/overlays .* results/i.test(name)) {
      add('Results overlays not present/toggling', [
        'Confirm `buttonOverlay` change calls `ensureOverlayEnhancementActive()` and `cleanupOverlays()`.',
        'Check MutationObserver and SPA url-change handling for YouTube results page.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else if (/channel pages/i.test(name)) {
      add('Channel button missing on tabs', [
        'Review selectors for subscribe/action areas across /videos, /shorts, /live.',
        'Fallback insert path when `.yt-flexible-actions-view-model-wiz__action` is absent.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else if (/shorts page/i.test(name)) {
      add('Shorts overlay/buttons issues', [
        'Ensure shorts overlay mount points exist and heights are matched.',
        'Double-check the side action and channel bar selectors in `updateButtons()`.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else if (/redirects to Odysee/i.test(name)) {
      add('Auto-redirect did not occur', [
        'Check `resolveById` stub and returned mapping type is `video`.',
        'Confirm redirect gating: not in playlist (`list` param) and timing window.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else if (/layout sanity/i.test(name)) {
      add('Button height mismatch', [
        'Inspect computed height/margins; mirror Subscribe styles more closely.',
        'Revisit inline padding/border radius in `WatchOnOdyseeButtons`.',
        `Screenshots: ${imgs.join(', ')}`,
      ])
    } else {
      add(`Failure: ${name}`, [err || 'See report for details', `Screenshots: ${imgs.join(', ')}`])
    }
  }

  return recs
}

function main() {
  const report = readJson(reportPath)
  if (!report) {
    console.error('No Playwright JSON report found at', reportPath)
    process.exit(0)
  }

  const { tests, counts } = summarize(report)

  // Compose summary markdown
  const lines = []
  lines.push('# E2E Summary')
  lines.push('')
  lines.push(`- Total: ${tests.length}`)
  lines.push(`- Passed: ${counts.passed || 0}`)
  lines.push(`- Failed: ${counts.failed || 0}`)
  lines.push(`- Timed out: ${counts.timedOut || counts['timedOut'] || 0}`)
  lines.push('')
  lines.push('## Tests')
  for (const t of tests) {
    const status = t.status
    const name = t.title
    lines.push(`- ${status.toUpperCase()}: ${name}`)
    for (const a of t.attachments || []) {
      if (!a.path) continue
      const rel = linkify(a.path)
      lines.push(`  - attachment: ${rel}`)
    }
  }

  writeFile(path.join(repoRoot, 'build', 'e2e-summary.md'), lines.join('\n'))

  // Recommendations
  const recs = analyze(tests)
  const recLines = ['# E2E Recommendations', '']
  if (recs.length === 0) recLines.push('- No recommendations. All tests passed.')
  for (const r of recs) {
    recLines.push(`- ${r.title}:`)
    for (const it of r.items) recLines.push(`  - ${it}`)
  }
  recLines.push('')
  recLines.push('- Additional artifacts: build/e2e-artifacts/')

  writeFile(path.join(repoRoot, 'build', 'e2e-recommendations.md'), recLines.join('\n'))

  console.log('Wrote build/e2e-summary.md and build/e2e-recommendations.md')
}

main()
