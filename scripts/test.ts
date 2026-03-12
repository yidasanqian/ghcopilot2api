import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const bunExecutable = Bun.which("bun") ?? "bun"
const testFiles = readdirSync("tests", { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join("tests", entry.name))
  .sort((left, right) => left.localeCompare(right))

for (const testFile of testFiles) {
  console.log(`\n==> ${testFile}`)

  const result = spawnSync(bunExecutable, ["test", testFile], {
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
