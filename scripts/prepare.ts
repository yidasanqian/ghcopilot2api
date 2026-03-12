import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

if (process.env.CI || !existsSync(".git")) {
  process.exit(0)
}

const result = spawnSync("bunx", ["simple-git-hooks"], {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
