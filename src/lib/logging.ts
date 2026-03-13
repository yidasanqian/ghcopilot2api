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

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, "0")
}
