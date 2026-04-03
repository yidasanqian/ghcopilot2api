import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 120
export const LOG_TIME_ZONE = "Asia/Shanghai"
export const LOG_TIME_ZONE_OFFSET_MINUTES = 8 * 60

process.env.TZ = LOG_TIME_ZONE
consola.options.formatOptions.date = true

export function getLogTimestamp(date: Date = new Date()): string {
  const gmt8Date = new Date(
    date.getTime() + LOG_TIME_ZONE_OFFSET_MINUTES * 60 * 1000,
  )

  const year = gmt8Date.getUTCFullYear()
  const month = padNumber(gmt8Date.getUTCMonth() + 1, 2)
  const day = padNumber(gmt8Date.getUTCDate(), 2)
  const hours = padNumber(gmt8Date.getUTCHours(), 2)
  const minutes = padNumber(gmt8Date.getUTCMinutes(), 2)
  const seconds = padNumber(gmt8Date.getUTCSeconds(), 2)
  const milliseconds = padNumber(gmt8Date.getUTCMilliseconds(), 3)

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+08:00`
}

export function prependLogTimestamp(
  message: string,
  date: Date = new Date(),
): string {
  return `[${getLogTimestamp(date)}] ${message}`
}

export function printTimestampedLog(
  message: string,
  ...rest: Array<string>
): void {
  console.log(prependLogTimestamp(message), ...rest)
}

export function printTimestampedLogAt(message: string, date: Date): void {
  console.log(prependLogTimestamp(message, date))
}

export function formatRequestDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`
  }

  return `${Math.round(durationMs / 1000)}s`
}

export function getRequestUrlForLog(requestUrl: string): string {
  return requestUrl
}

const UPSTREAM_REQUEST_LOG_URL_KEY = "upstreamRequestLogUrl"
const REQUEST_LOG_START_AT_KEY = "requestLogStartAt"
const REQUEST_LOG_METHOD_KEY = "requestLogMethod"
const REQUEST_LOG_STARTED_KEY = "requestLogStarted"

export function setUpstreamRequestLogUrl(c: Context, url: string): void {
  c.set(UPSTREAM_REQUEST_LOG_URL_KEY, url)

  if (isRequestStartLogged(c)) {
    return
  }

  const method = getRequestLogMethod(c)
  const startAt = getRequestLogStartAt(c)

  if (!method || startAt === undefined) {
    return
  }

  printTimestampedLogAt(`--> ${method} ${url}`, new Date(startAt))
  markRequestStartLogged(c)
}

function getUpstreamRequestLogUrl(c: Context): string | undefined {
  const value = c.get(UPSTREAM_REQUEST_LOG_URL_KEY) as unknown
  return typeof value === "string" ? value : undefined
}

function getRequestLogStartAt(c: Context): number | undefined {
  const value = c.get(REQUEST_LOG_START_AT_KEY) as unknown
  return typeof value === "number" ? value : undefined
}

function getRequestLogMethod(c: Context): string | undefined {
  const value = c.get(REQUEST_LOG_METHOD_KEY) as unknown
  return typeof value === "string" ? value : undefined
}

function isRequestStartLogged(c: Context): boolean {
  return c.get(REQUEST_LOG_STARTED_KEY) === true
}

function markRequestStartLogged(c: Context): void {
  c.set(REQUEST_LOG_STARTED_KEY, true)
}

export function requestLoggingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method
    const requestUrl = getRequestUrlForLog(c.req.url)
    const startAt = Date.now()
    c.set(REQUEST_LOG_METHOD_KEY, method)
    c.set(REQUEST_LOG_START_AT_KEY, startAt)

    try {
      await next()
    } finally {
      const duration = Date.now() - startAt
      const loggedUrl = getUpstreamRequestLogUrl(c) ?? requestUrl

      if (!isRequestStartLogged(c)) {
        printTimestampedLogAt(`--> ${method} ${loggedUrl}`, new Date(startAt))
        markRequestStartLogged(c)
      }

      printTimestampedLog(
        `<-- ${method} ${loggedUrl} ${c.res.status} ${formatRequestDuration(duration)}`,
      )
    }
  }
}

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, "0")
}
