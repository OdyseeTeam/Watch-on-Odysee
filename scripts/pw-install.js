/* eslint-disable no-console */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.error) throw res.error
  return res.status || 0
}

const isWin = process.platform === 'win32'
const isLinux = process.platform === 'linux'

// Prefer local playwright CLI from node_modules/.bin to avoid PATH issues
const localBin = path.join(process.cwd(), 'node_modules', '.bin', isWin ? 'playwright.cmd' : 'playwright')
const hasLocal = fs.existsSync(localBin)

// Only Chromium is needed for this suite
const args = ['install', 'chromium']
if (isLinux) args.push('--with-deps')

try {
  if (hasLocal) {
    console.log(`Running local CLI: ${localBin} ${args.join(' ')}`)
    if (isWin) process.exit(run('cmd.exe', ['/c', localBin, ...args]))
    else process.exit(run(localBin, args))
  }

  if (isWin) {
    console.log('Local CLI not found, using npx via cmd.exe')
    process.exit(run('cmd.exe', ['/c', 'npx', 'playwright', ...args]))
  } else {
    console.log('Local CLI not found, using npx')
    process.exit(run('npx', ['playwright', ...args]))
  }
} catch (err) {
  console.error('Failed to run Playwright install:', err)
  console.error('Fallback: try one of the following:')
  console.error('  npx playwright install chromium')
  if (isLinux) console.error('  npx playwright install --with-deps')
  process.exit(1)
}
