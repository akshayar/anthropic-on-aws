#!/usr/bin/env node
/**
 * Extract the FULL gateway config into a static JS module (src/gatewayConfig.js)
 * so the admin UI's read-only "Gateway Config" page can display it in full.
 *
 * WHY THIS EXISTS: the gateway exposes NO endpoint that returns its own config —
 * only spend_limits, health, discovery, and the per-group-gated /user/bootstrap
 * (which returns ONLY the caller's group's Desktop slice, never the whole config).
 * The full config (all groups, models catalog, OIDC, upstreams, admin, telemetry)
 * lives only in gateway.yaml, which is baked into the gateway image at build time.
 * So the only faithful source for "the full config" is that YAML file itself —
 * and since it is baked into the image, this build-time snapshot IS what runs.
 *
 * SECRETS: gateway.yaml carries secrets ONLY as `${ENV_VAR}` references (expanded
 * by the gateway at boot, never literal in the file) — but we defensively redact
 * anyway: every `${...}` value and any line whose key looks secret is masked
 * before baking. Nothing sensitive reaches the browser bundle.
 *
 * Source config resolution order (same as extract-config-groups.mjs):
 *   1. $GATEWAY_CONFIG env var (an explicit path)
 *   2. ../../cdk/gateway.yaml          (the stamped, deployed config, if present)
 *   3. ../../cdk/gateway.yaml.template (checked-in template — always present)
 *
 * Run via `npm run build` (prebuild hook) or manually. Output is deterministic.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cdkDir = resolve(__dirname, '..', '..', 'cdk')

function pickConfigPath() {
  if (process.env.GATEWAY_CONFIG && existsSync(process.env.GATEWAY_CONFIG)) {
    return process.env.GATEWAY_CONFIG
  }
  const stamped = resolve(cdkDir, 'gateway.yaml')
  if (existsSync(stamped)) return stamped
  const template = resolve(cdkDir, 'gateway.yaml.template')
  if (existsSync(template)) return template
  return null
}

// Keys whose VALUE must never be shown, even if it isn't a ${...} reference.
const SECRET_KEY_RE = /^(\s*)(jwt_secret|client_secret|password|api_key|.*_secret|.*_key)\s*:/i

/**
 * Redact secret material from the raw YAML, line by line:
 *   - any value that is a ${ENV} reference  -> keep the key, show «redacted (env)»
 *   - any secret-looking key with a literal  -> keep the key, show «redacted»
 * Comments and everything else pass through unchanged.
 */
function redactYaml(yaml) {
  return yaml.split('\n').map(line => {
    // Leave comment-only lines alone.
    const noComment = line.replace(/#.*$/, '')
    if (!noComment.includes(':')) return line

    // Value is an ${ENV} secret reference → env-injected at boot, never literal.
    if (/:\s*\$\{[^}]+\}/.test(noComment) || /\$\{[^}]+\}/.test(noComment.split(':').slice(1).join(':'))) {
      // Only redact when the ${...} is the whole value (e.g. postgres_url embeds
      // ${DB_HOST} but is otherwise safe to show — mask just the interpolation).
      const [k, ...rest] = line.split(':')
      const val = rest.join(':')
      if (/^\s*\$\{[^}]+\}\s*(#.*)?$/.test(val)) {
        return `${k}: «redacted (env-injected at boot)»`
      }
      // Partial interpolation (URLs) — mask the ${...} tokens but keep structure.
      return line.replace(/\$\{[^}]+\}/g, '«env»')
    }

    // Secret-looking key with a literal value → mask the value.
    const m = line.match(SECRET_KEY_RE)
    if (m) {
      return `${m[1]}${line.trim().split(':')[0]}: «redacted»`
    }
    return line
  }).join('\n')
}

/** Pull the bracketed list after a `key:` into an array of trimmed names. */
function bracketList(text, key) {
  const out = []
  const re = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '')
      if (name && !name.startsWith('@@') && !name.startsWith('${')) out.push(name)
    }
  }
  return out
}

/** Extract the model catalog ids + labels from the `models:` block. */
function extractModels(text) {
  const models = []
  const re = /-\s*id:\s*([^\n#]+)\s*\n\s*label:\s*([^\n#]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    models.push({ id: m[1].trim(), label: m[2].trim() })
  }
  return models
}

/**
 * Strip commented-out config so only the ACTIVE (uncommented) config remains.
 *   - drop full-line comments (whitespace then `#...`)
 *   - strip trailing inline comments (` # ...`) but NOT inside quoted strings
 *   - collapse the blank-line runs left behind
 * Applied before redaction so the baked snapshot shows only live config.
 */
function stripComments(yaml) {
  const kept = []
  for (const line of yaml.split('\n')) {
    // Full-line comment (or blank-then-#) → drop entirely.
    if (/^\s*#/.test(line)) continue
    // Strip a trailing inline comment, but leave `#` that sits inside quotes.
    let out = line
    let inS = false, inD = false
    for (let i = 0; i < out.length; i++) {
      const c = out[i]
      if (c === "'" && !inD) inS = !inS
      else if (c === '"' && !inS) inD = !inD
      else if (c === '#' && !inS && !inD) { out = out.slice(0, i); break }
    }
    out = out.replace(/\s+$/, '')
    kept.push(out)
  }
  // Collapse 2+ consecutive blank lines into one.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

const configPath = pickConfigPath()
const outPath = resolve(__dirname, '..', 'src', 'gatewayConfig.js')

if (!configPath) {
  // No config reachable (e.g. inside the Docker build, whose context is only
  // admin-app/). Do NOT clobber an already-generated file; keep the committed one.
  if (existsSync(outPath)) {
    console.warn('[extract-gateway-config] no gateway config reachable; keeping existing src/gatewayConfig.js')
    process.exit(0)
  }
  console.warn('[extract-gateway-config] no gateway config reachable and no existing snapshot; writing empty stub')
}

const raw = configPath ? readFileSync(configPath, 'utf8') : ''
const active = stripComments(raw)
const redacted = redactYaml(active)
const sourceName = configPath ? basename(configPath) : '(none)'
const isStamped = sourceName === 'gateway.yaml'

const snapshot = {
  source: sourceName,
  // Stamped = real deployed values; template = generic placeholders.
  stamped: isStamped,
  generatedAt: new Date().toISOString(),
  groups: [...new Set([...bracketList(raw, 'groups'), ...bracketList(raw, 'admin_groups')])].sort(),
  adminGroups: bracketList(raw, 'admin_groups'),
  models: extractModels(raw),
  yaml: redacted,
}

const banner = `// AUTO-GENERATED by scripts/extract-gateway-config.mjs — do not edit by hand.\n`
  + `// Source: ${configPath ? configPath.replace(cdkDir, 'cdk') : '(none found)'}\n`
  + `// Full gateway config snapshot (secrets redacted) for the read-only admin\n`
  + `// Gateway Config page. Baked at build time — matches the running image because\n`
  + `// the same YAML is baked into the gateway container.\n`
writeFileSync(outPath, `${banner}export const GATEWAY_CONFIG = ${JSON.stringify(snapshot, null, 2)}\n`)

console.log(`[extract-gateway-config] wrote snapshot from ${sourceName} (${snapshot.models.length} models, ${snapshot.groups.length} groups, stamped=${isStamped})`)
