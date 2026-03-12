import consola from "consola"
import { createHash } from "node:crypto"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

const OPENAI_COMPATIBLE_USER_MAX_LENGTH = 64

export function normalizeOpenAICompatibleUser(
  user: string | null | undefined,
): string | undefined {
  const trimmedUser = user?.trim()

  if (!trimmedUser) {
    return undefined
  }

  if (trimmedUser.length <= OPENAI_COMPATIBLE_USER_MAX_LENGTH) {
    return trimmedUser
  }

  const hash = createHash("sha256")
    .update(trimmedUser)
    .digest("hex")
    .slice(0, 16)
  const prefixLength = OPENAI_COMPATIBLE_USER_MAX_LENGTH - hash.length - 1

  return `${trimmedUser.slice(0, prefixLength)}-${hash}`
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
