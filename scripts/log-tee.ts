import { once } from "node:events"
import { mkdir, open, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

const DEFAULT_LOG_FILE_MAX_SIZE_BYTES = 100 * 1024 * 1024
const DEFAULT_LOG_FILE_MAX_FILES = 5

const SIZE_MULTIPLIERS = new Map<string, number>([
  ["b", 1],
  ["k", 1024],
  ["kb", 1024],
  ["m", 1024 * 1024],
  ["mb", 1024 * 1024],
  ["g", 1024 * 1024 * 1024],
  ["gb", 1024 * 1024 * 1024],
])

export interface MirrorLogStreamOptions {
  logFile: string
  maxFiles: number
  maxSizeBytes: number
  onStdoutChunk?: (chunk: Uint8Array) => Promise<void> | void
}

export async function mirrorLogStream(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: MirrorLogStreamOptions,
): Promise<void> {
  await mkdir(dirname(options.logFile), { recursive: true })

  let currentSize = await getFileSize(options.logFile)
  let fileHandle = await open(options.logFile, "a")

  try {
    for await (const chunk of input) {
      await writeStdoutChunk(chunk, options.onStdoutChunk)

      if (
        options.maxSizeBytes > 0
        && currentSize > 0
        && currentSize + chunk.byteLength > options.maxSizeBytes
      ) {
        await fileHandle.close()
        await rotateLogFiles(options.logFile, options.maxFiles)
        fileHandle = await open(options.logFile, "a")
        currentSize = 0
      }

      await fileHandle.write(chunk)
      currentSize += chunk.byteLength
    }
  } finally {
    await fileHandle.close()
  }
}

export function resolveLogRotationConfig(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = defaultWarn,
): Pick<MirrorLogStreamOptions, "maxFiles" | "maxSizeBytes"> {
  const maxSizeBytes = parseMaxSizeBytes(env.LOG_FILE_MAX_SIZE, warn)
  const maxFiles = parseMaxFiles(env.LOG_FILE_MAX_FILES, warn)

  return {
    maxFiles,
    maxSizeBytes,
  }
}

export async function runCli(args: Array<string>): Promise<number> {
  const logFile = args[0]

  if (!logFile) {
    console.error("Usage: bun /app/scripts/log-tee.ts <log-file-path>")
    return 1
  }

  const rotationConfig = resolveLogRotationConfig(process.env)
  await mirrorLogStream(readableStreamToAsyncIterable(Bun.stdin.stream()), {
    logFile,
    ...rotationConfig,
  })

  return 0
}

function parseMaxSizeBytes(
  value: string | undefined,
  warn: (message: string) => void,
): number {
  if (!value || value.trim() === "") {
    return DEFAULT_LOG_FILE_MAX_SIZE_BYTES
  }

  const normalized = value.trim().toLowerCase()

  if (normalized === "0") {
    return 0
  }

  const match = normalized.match(/^(\d+)([a-z]*)$/)

  if (!match) {
    warn(
      `Invalid LOG_FILE_MAX_SIZE="${value}", fallback to ${DEFAULT_LOG_FILE_MAX_SIZE_BYTES} bytes.`,
    )
    return DEFAULT_LOG_FILE_MAX_SIZE_BYTES
  }

  const [, amountText, unitText] = match
  const unit = unitText === "" ? "b" : unitText
  const multiplier = SIZE_MULTIPLIERS.get(unit)

  if (!multiplier) {
    warn(
      `Invalid LOG_FILE_MAX_SIZE="${value}", fallback to ${DEFAULT_LOG_FILE_MAX_SIZE_BYTES} bytes.`,
    )
    return DEFAULT_LOG_FILE_MAX_SIZE_BYTES
  }

  const amount = Number(amountText)

  if (!Number.isSafeInteger(amount) || amount < 0) {
    warn(
      `Invalid LOG_FILE_MAX_SIZE="${value}", fallback to ${DEFAULT_LOG_FILE_MAX_SIZE_BYTES} bytes.`,
    )
    return DEFAULT_LOG_FILE_MAX_SIZE_BYTES
  }

  return amount * multiplier
}

function parseMaxFiles(
  value: string | undefined,
  warn: (message: string) => void,
): number {
  if (!value || value.trim() === "") {
    return DEFAULT_LOG_FILE_MAX_FILES
  }

  const parsed = Number(value.trim())

  if (!Number.isInteger(parsed) || parsed < 1) {
    warn(
      `Invalid LOG_FILE_MAX_FILES="${value}", fallback to ${DEFAULT_LOG_FILE_MAX_FILES}.`,
    )
    return DEFAULT_LOG_FILE_MAX_FILES
  }

  return parsed
}

async function rotateLogFiles(
  logFile: string,
  maxFiles: number,
): Promise<void> {
  if (maxFiles < 1) {
    return
  }

  await removeIfExists(`${logFile}.${maxFiles}`)

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await renameIfExists(`${logFile}.${index}`, `${logFile}.${index + 1}`)
  }

  await renameIfExists(logFile, `${logFile}.1`)
}

async function getFileSize(path: string): Promise<number> {
  try {
    const result = await stat(path)
    return result.size
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0
    }

    throw error
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
}

async function writeStdoutChunk(
  chunk: Uint8Array,
  writer: ((chunk: Uint8Array) => Promise<void> | void) | undefined,
): Promise<void> {
  if (writer) {
    await writer(chunk)
    return
  }

  if (process.stdout.write(Buffer.from(chunk))) {
    return
  }

  await once(process.stdout, "drain")
}

function readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()

      try {
        while (true) {
          const result = await reader.read()

          if (result.done) {
            break
          }

          yield result.value
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}

function defaultWarn(message: string): void {
  console.error(`[log-tee] ${message}`)
}

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2))
  process.exit(exitCode)
}
