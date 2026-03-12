export interface InitiatorMessageLike {
  role: string
}

export function resolveInitiator(
  messages: Array<InitiatorMessageLike>,
): "agent" | "user" {
  return (
      messages.some((message) => ["assistant", "tool"].includes(message.role))
    ) ?
      "agent"
    : "user"
}
