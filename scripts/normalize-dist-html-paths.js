#!/usr/bin/env node
// Normalize backslashes in built HTML asset paths to forward slashes.
// Fixes Windows builds where Parcel may emit "\\" in href/src, which
// breaks Firefox extension URLs (moz-extension://).

const fs = require('fs')
const path = require('path')

const distDir = path.resolve(__dirname, '..', 'dist')
const isOnce = process.argv.includes('--once')

function normalizeHtmlFile(file) {
  try {
    const html = fs.readFileSync(file, 'utf8')
    // Replace backslashes in src/href attribute values only
    const fixed = html.replace(/\b(src|href)="([^"]*\\[^\"]*)"/g, (_m, attr, val) => {
      return `${attr}="${val.replace(/\\/g, '/')}"`
    })
    if (fixed !== html) {
      fs.writeFileSync(file, fixed)
      log(`Normalized slashes: ${path.relative(process.cwd(), file)}`)
    }
  } catch (err) {
    // Non-fatal
  }
}

function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.html$/i.test(e.name)) normalizeHtmlFile(p)
  }
}

function log(msg) {
  try { console.log(`[normalize-html] ${msg}`) } catch {}
}

function runOnce() {
  if (!fs.existsSync(distDir)) return
  walk(distDir)
}

function runWatch() {
  log('Watching dist/ for HTML changes...')
  runOnce()
  // Simple polling loop to stay cross-platform without extra deps
  setInterval(runOnce, 1200)
}

if (isOnce) runOnce()
else runWatch()

