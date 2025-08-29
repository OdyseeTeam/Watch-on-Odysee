/* eslint-disable no-console */
// Triggers the E2E GitHub Actions workflow and streams a compact status, then prints summary files.
// Requires: Node 18+, a GitHub token with repo scope in GH_TOKEN (or GITHUB_TOKEN)
// Optional: GH_OWNER, GH_REPO, GH_REF; otherwise inferred from git remote and current branch

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function inferRepo() {
  try {
    const remote = sh('git config --get remote.origin.url')
    // Handle git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const m = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/)
    if (m) return { owner: m[1], repo: m[2] }
  } catch {}
  return null
}

async function run() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    console.error('Missing GH_TOKEN (or GITHUB_TOKEN). Set a GitHub token with "repo" scope to trigger workflows.')
    process.exit(1)
  }

  let owner = process.env.GH_OWNER
  let repo = process.env.GH_REPO
  if (!owner || !repo) {
    const inferred = inferRepo()
    if (!inferred) {
      console.error('Cannot infer repo from git remote. Set GH_OWNER and GH_REPO env vars.')
      process.exit(1)
    }
    owner = inferred.owner
    repo = inferred.repo
  }
  let ref = process.env.GH_REF
  if (!ref) {
    try { ref = sh('git rev-parse --abbrev-ref HEAD') } catch {}
    if (!ref) ref = 'main'
  }

  const base = `https://api.github.com/repos/${owner}/${repo}`
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  // Dispatch workflow
  const wfPath = 'e2e.yml'
  console.log(`Dispatching workflow ${wfPath} on ref ${ref} ...`)
  let res = await fetch(`${base}/actions/workflows/${wfPath}/dispatches`, {
    method: 'POST', headers,
    body: JSON.stringify({ ref })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('Failed to dispatch workflow:', res.status, text)
    process.exit(1)
  }
  const startedAt = Date.now()

  // Poll for the newly created run
  let runId = null
  let attempt = 0
  while (!runId && attempt++ < 60) {
    await new Promise(r => setTimeout(r, 5000))
    const runsRes = await fetch(`${base}/actions/workflows/${wfPath}/runs?event=workflow_dispatch&per_page=5`, { headers })
    const data = await runsRes.json()
    const latest = (data.workflow_runs || []).find(r => r.head_branch === ref)
    if (latest) runId = latest.id
  }
  if (!runId) {
    console.error('Timed out waiting for workflow run to appear')
    process.exit(1)
  }
  console.log('Run ID:', runId)

  // Stream status until completion
  let lastStatus = ''
  while (true) {
    const r = await fetch(`${base}/actions/runs/${runId}`, { headers })
    const d = await r.json()
    const status = `${d.status}/${d.conclusion || 'pending'}`
    if (status !== lastStatus) {
      console.log(`Status: ${status}`)
      lastStatus = status
    }
    if (d.status === 'completed') break
    await new Promise(r => setTimeout(r, 5000))
  }

  // Download artifacts (summaries and report)
  const artifactsDir = path.join(process.cwd(), 'ci-artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  const artsRes = await fetch(`${base}/actions/runs/${runId}/artifacts`, { headers })
  const arts = await artsRes.json()
  for (const a of arts.artifacts || []) {
    const url = `${base}/actions/artifacts/${a.id}/zip`
    const zipRes = await fetch(url, { headers })
    if (!zipRes.ok) continue
    const buf = Buffer.from(await zipRes.arrayBuffer())
    const out = path.join(artifactsDir, `${a.name}.zip`)
    fs.writeFileSync(out, buf)
    console.log('Downloaded artifact:', out, `(${(buf.length/1024/1024).toFixed(2)} MB)`)    
  }

  console.log('Done. See ci-artifacts/ for zipped reports. Unzip e2e-summaries-* to read e2e-summary.md and e2e-recommendations.md.')
}

run().catch((e) => { console.error(e); process.exit(1) })

