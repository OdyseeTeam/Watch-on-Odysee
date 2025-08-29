// Minimal logger that no-ops in production builds.
// NODE_ENV is set to 'production' in build scripts; in watch/dev it's undefined.
// Keep declarations local to avoid adding global Node types.
declare const process: any

const env = (typeof process !== 'undefined' && process && process.env && process.env.NODE_ENV) || 'development'
const isProd = env === 'production'

type AnyArgs = any[]

function noop(..._args: AnyArgs) { /* no-op in production */ }

export const logger = {
  log: (...args: AnyArgs) => isProd ? noop(...args) : console.log(...args),
  info: (...args: AnyArgs) => isProd ? noop(...args) : console.info(...args),
  debug: (...args: AnyArgs) => isProd ? noop(...args) : console.debug(...args),
  warn: (...args: AnyArgs) => isProd ? noop(...args) : console.warn(...args),
  error: (...args: AnyArgs) => isProd ? noop(...args) : console.error(...args),
}

