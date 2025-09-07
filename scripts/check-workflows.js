/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const dir = path.join(root, '.github', 'workflows')

const DEPRECATED = [
  /actions\/upload-artifact@v1\b/i,
  /actions\/upload-artifact@v2\b/i,
  /actions\/download-artifact@v1\b/i,
  /actions\/download-artifact@v2\b/i,
  /microsoft\/playwright-github-action@v1\b/i,
]

function main() {
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  let bad = []
  for (const f of files) {
    const p = path.join(dir, f)
    const content = fs.readFileSync(p, 'utf8')
    for (const re of DEPRECATED) {
      if (re.test(content)) bad.push({ file: f, match: re.source })
    }
  }
  if (bad.length) {
    console.error('Deprecated actions found in workflow files:')
    for (const b of bad) console.error(`- ${b.file} matches '${b.match}'`)
    console.error('Please update to actions/upload-artifact@v4 or actions/download-artifact@v4, and remove microsoft/playwright-github-action.')
    process.exit(1)
  } else {
    console.log('Workflows look good: no deprecated actions found.')
  }
}

main()

