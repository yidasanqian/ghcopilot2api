import { Hono } from "hono"

import { copilotBaseUrl } from "~/lib/api-config"
import { forwardError } from "~/lib/error"
import { setUpstreamRequestLogUrl } from "~/lib/logging"
import { state } from "~/lib/state"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    setUpstreamRequestLogUrl(c, `${copilotBaseUrl(state)}/embeddings`)
    const paylod = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(paylod)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
