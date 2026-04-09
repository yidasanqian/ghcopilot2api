export async function getResponseBodyForLog(
  response: Response,
): Promise<unknown> {
  try {
    const responseText = await response.clone().text()

    if (!responseText) {
      return null
    }

    try {
      return JSON.parse(responseText) as unknown
    } catch {
      return responseText
    }
  } catch (error) {
    return {
      failedToReadBody: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

type LoggableHeaders =
  | Headers
  | Array<[string, string]>
  | Record<string, string>

export function getRequestHeadersForLog(
  headers: LoggableHeaders | undefined,
): Record<string, string> {
  if (!headers) {
    return {}
  }

  let entries: Iterable<[string, string]>

  if (headers instanceof Headers) {
    entries = headers.entries()
  } else if (Array.isArray(headers)) {
    entries = headers
  } else {
    entries = Object.entries(headers)
  }

  return Object.fromEntries(
    Array.from(entries, ([name, value]) => [
      name,
      isSensitiveHeader(name) ? redactHeaderValue(name, value) : value,
    ]),
  )
}

export function getResponseHeadersForLog(
  response: Response,
): Record<string, string> {
  return Object.fromEntries(response.headers.entries())
}

export async function getResponseLogDetails(response: Response) {
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: getResponseHeadersForLog(response),
    body: await getResponseBodyForLog(response),
  }
}

export async function getUpstreamErrorLog(
  error: unknown,
): Promise<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    return {
      value: String(error),
    }
  }

  const response = getResponseFromUnknown(error)

  return {
    name: error.name,
    message: error.message,
    code: getErrorCode(error),
    ...(response ? { response: await getResponseLogDetails(response) } : {}),
  }
}

function getErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function getResponseFromUnknown(
  value: unknown,
  depth = 0,
): Response | undefined {
  if (value instanceof Response) {
    return value
  }

  if (!isObjectLike(value) || depth >= 4) {
    return undefined
  }

  const candidate = value as {
    response?: unknown
    cause?: unknown
  }

  if (candidate.response instanceof Response) {
    return candidate.response
  }

  const nestedResponse =
    getResponseFromUnknown(candidate.response, depth + 1)
    ?? getResponseFromUnknown(candidate.cause, depth + 1)

  return nestedResponse
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isSensitiveHeader(name: string): boolean {
  return ["authorization", "proxy-authorization"].includes(name.toLowerCase())
}

function redactHeaderValue(name: string, value: string): string {
  const normalizedName = name.toLowerCase()

  if (normalizedName === "authorization") {
    const [scheme] = value.split(/\s+/, 1)
    return scheme ? `${scheme} [REDACTED]` : "[REDACTED]"
  }

  return "[REDACTED]"
}
