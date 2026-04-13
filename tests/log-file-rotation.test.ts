import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

type LogTeeModule = typeof import("../scripts/log-tee")

const tempDirs: Array<string> = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  )
})

describe("log file rotation", () => {
  test("rotates host-mounted log files by size while preserving stdout", async () => {
    const { mirrorLogStream } = (await import(
      pathToFileURL(join(process.cwd(), "scripts", "log-tee.ts")).href
    )) as LogTeeModule

    const tempDir = await mkdtemp(join(tmpdir(), "ghcopilot2api-log-rotate-"))
    tempDirs.push(tempDir)

    const logFile = join(tempDir, "copilot-api.log")
    const chunks = ["abcd\n", "efgh\n", "ijkl\n", "mnop\n"]
    const textDecoder = new TextDecoder()

    const stdoutChunks: Array<string> = []

    await mirrorLogStream(textChunks(chunks), {
      logFile,
      maxFiles: 1,
      maxSizeBytes: 12,
      onStdoutChunk(chunk) {
        stdoutChunks.push(textDecoder.decode(chunk))
      },
    })

    expect(stdoutChunks.join("")).toBe(chunks.join(""))

    const files = (await readdir(tempDir)).sort()
    expect(files).toEqual(["copilot-api.log", "copilot-api.log.1"])

    expect(await readFile(logFile, "utf8")).toBe("ijkl\nmnop\n")
    expect(await readFile(`${logFile}.1`, "utf8")).toBe("abcd\nefgh\n")
  })
})

function* textChunks(chunks: Array<string>): Iterable<Uint8Array> {
  const encoder = new TextEncoder()

  for (const chunk of chunks) {
    yield encoder.encode(chunk)
  }
}
