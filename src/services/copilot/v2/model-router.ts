import { state } from "~/lib/state"

export const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
export const RESPONSES_ENDPOINT = "/responses"
export const MESSAGES_ENDPOINT = "/v1/messages"

export type UpstreamApi = "chat-completions" | "responses" | "messages"

function getSupportedEndpoints(modelId: string): Array<string> | undefined {
  return state.models?.data.find((model) => model.id === modelId)
    ?.supported_endpoints
}

export function supportsEndpoint(modelId: string, endpoint: string): boolean {
  return getSupportedEndpoints(modelId)?.includes(endpoint) ?? false
}

export function shouldUseResponsesApi(modelId: string): boolean {
  return supportsEndpoint(modelId, RESPONSES_ENDPOINT)
}

export function shouldUseMessagesApi(modelId: string): boolean {
  return (
    state.anthropicUseMessagesApi
    && supportsEndpoint(modelId, MESSAGES_ENDPOINT)
  )
}

export function resolveMessagesUpstreamApi(modelId: string): UpstreamApi {
  if (shouldUseResponsesApi(modelId)) {
    return "responses"
  }

  if (shouldUseMessagesApi(modelId)) {
    return "messages"
  }

  return "chat-completions"
}

export function resolveResponsesUpstreamApi(modelId: string): UpstreamApi {
  return resolveMessagesUpstreamApi(modelId)
}

export function resolveChatCompletionsUpstreamApi(
  modelId: string,
): Exclude<UpstreamApi, "responses"> {
  if (shouldUseMessagesApi(modelId)) {
    return "messages"
  }

  return "chat-completions"
}
