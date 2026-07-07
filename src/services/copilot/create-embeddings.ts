import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithUpstreamRetry } from "~/lib/upstream-retry"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = copilotHeaders(state)
  const response = await fetchWithUpstreamRetry({
    exhaustedMessage: "Failed to reach upstream embeddings API",
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    operationName: "embeddings",
    requestId: headers["x-request-id"],
    requestMetadata: {
      model: payload.model,
      inputCount: Array.isArray(payload.input) ? payload.input.length : 1,
    },
    url: `${copilotBaseUrl(state)}/embeddings`,
  })

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
