/**
 * Host half of `dsh-prompt-complete`.
 *
 * Owns one HTTP route: POST /dsh-prompt-complete/refine
 * Reads the live session transcript, asks the session's own model route to
 * rewrite the caller's draft into a complete prompt, and returns it as JSON.
 * The Client module owns every pixel; this half never renders anything.
 */

const NAME = 'dsh-prompt-complete'
const ROUTE_REFINE = '/dsh-prompt-complete/refine'
const ROUTE_STATUS = '/dsh-prompt-complete/status'
const BUILD = '1.0.0'

const MAX_BODY_BYTES = 262144
const MAX_TRANSCRIPT_CHARS = 14000
const MAX_TURNS = 24
const MAX_MESSAGE_CHARS = 1600
const MAX_DRAFT_CHARS = 8000
const MAX_RESULT_CHARS = 12000

const DEFAULT_MAX_TOKENS = 1600
const DEFAULT_TIMEOUT_MS = 180000

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const SYSTEM_PROMPT = [
  'You rewrite a user\'s draft message into one complete, precise prompt for the coding agent on the other side of this conversation.',
  '',
  'You receive:',
  '1. A transcript of the conversation so far (user and assistant turns).',
  '2. The user\'s draft prompt, which may be terse, fragmentary, or empty.',
  '',
  'Produce the message the user should actually send.',
  '',
  'Hard rules:',
  '- Preserve the user\'s intent, scope, language, and every constraint they already stated. Never add requirements they did not imply.',
  '- Ground the rewrite only in facts visible in the transcript: file paths, decisions, error text, environment, prior outcomes. Never invent paths, APIs, versions, or identifiers.',
  '- Make implicit asks explicit: the goal, the current state, the concrete change wanted, acceptance criteria, and hard constraints (including what must not be touched).',
  '- Resolve pronouns and dangling references using the transcript so the prompt stands alone.',
  '- Reply in the language of the draft. If the draft is empty, reply in the transcript\'s language.',
  '- Be dense and imperative. No preamble, no headings, no meta commentary, no "here is your prompt", no surrounding code fence, no quotation marks around the result.',
  '- Length is not a goal: a three-line prompt that fully pins down the task beats a padded essay.',
  '',
  'If the draft is empty, write the single most useful next message the user would send, inferred from the open work in the transcript.',
  '',
  'Output the prompt text only.',
].join('\n')

/**
 * Whether a `Host` header names a loopback authority.
 * @param {string} host - the request's Host header.
 * @returns {boolean} whether it is loopback.
 */
function loopbackAuthority(host) {
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Reject cross-site and non-loopback requests: this route spends model tokens.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} whether the request is trusted.
 */
function sameOrigin(request) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read a size-capped request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<string>} the decoded body.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON body.
 */
function send(response, status, payload) {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * Read one error's text.
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Flatten one message's content blocks into plain text.
 * @param {{ content?: readonly unknown[] }} message - a message.
 * @returns {string} its text.
 */
function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Convert a conversation tail into transcript lines.
 * @param {readonly { role: string, text: string }[]} turns - collected turns.
 * @returns {string} the transcript.
 */
function renderTranscript(turns) {
  const lines = []
  let budget = MAX_TRANSCRIPT_CHARS
  for (const turn of turns) {
    if (budget <= 0) break
    const body = turn.text.length > MAX_MESSAGE_CHARS ? `${turn.text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]` : turn.text
    const line = `[${turn.role}] ${body}`
    lines.push(line)
    budget -= line.length
  }
  return lines.join('\n\n')
}

/**
 * Enforce the model's answer into a bare prompt string.
 * @param {string} text - the raw answer.
 * @returns {string} the cleaned prompt.
 */
function cleanAnswer(text) {
  let value = text.trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(value)
  if (fence !== null) value = fence[1].trim()
  if (value.length > MAX_RESULT_CHARS) value = value.slice(0, MAX_RESULT_CHARS).trimEnd()
  return value
}

/**
 * Resolve the model route for one session, falling back to the first registered one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} sessionId - the session to resolve.
 * @returns {Promise<{ provider: string, model: string } | undefined>} the route.
 */
async function resolveRoute(ctx, sessionId) {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  if (sessionId !== undefined) {
    const session = ctx.get('sessions')?.get?.(sessionId)
    const config = session?.requestHeader?.()?.config
    if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      if (models.length > 0) return { provider: provider.id, model: models[0].id }
    } catch {
      // A provider whose catalog cannot be listed is simply skipped.
    }
  }
  return undefined
}

/**
 * Collect the conversation tail for one session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} sessionId - the session to read.
 * @returns {Promise<{ role: string, text: string }[]>} the turns, oldest first.
 */
async function readTurns(ctx, sessionId) {
  if (sessionId === undefined) return []
  const turns = []
  const collect = (role, message) => {
    const text = textOfMessage(message)
    if (text.length > 0) turns.push({ role, text })
  }

  const live = ctx.get('sessions')?.get?.(sessionId)
  if (live !== undefined && typeof live.deriveMessages === 'function') {
    for (const message of live.deriveMessages()) {
      if (message?.role === 'user') collect('user', message)
      else if (message?.role === 'assistant') collect('assistant', message)
    }
  } else {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      const snapshot = await query.readSession(sessionId)
      for (const event of snapshot?.events ?? []) {
        if (event?.type === 'user/message') collect('user', event.data?.message)
        else if (event?.type === 'assistant/message') collect('assistant', event.data?.message)
      }
    }
  }
  return turns.slice(-MAX_TURNS)
}

/**
 * Build the single user request handed to the model.
 * @param {string} transcript - the rendered conversation.
 * @param {string} draft - the caller's draft.
 * @returns {string} the request text.
 */
function buildRequest(transcript, draft) {
  const parts = []
  parts.push(transcript.length > 0 ? `<<<CONVERSATION>>>\n${transcript}\n<<<END CONVERSATION>>>` : '<<<CONVERSATION>>>\n(no prior turns)\n<<<END CONVERSATION>>>')
  if (draft.length > 0) {
    parts.push(`<<<DRAFT>>>\n${draft}\n<<<END DRAFT>>>`)
    parts.push('Rewrite the draft under the rules you were given. Output the prompt text only.')
  } else {
    parts.push('<<<DRAFT>>>\n(empty)\n<<<END DRAFT>>>')
    parts.push('The draft is empty. Write the single most useful next prompt the user would send, inferred from the open work above. Output the prompt text only.')
  }
  return parts.join('\n\n')
}

/**
 * Stream one rewrite from the current adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ provider: string, model: string }} route - the resolved route.
 * @param {string} request - the request text.
 * @param {AbortSignal} signal - cancellation.
 * @param {{ maxTokens: number, temperature: number }} tuning - request controls.
 * @returns {Promise<{ prompt: string, usage: object | undefined, finish: string }>} the rewrite.
 */
async function rewrite(ctx, route, request, signal, tuning) {
  const llm = ctx.get('llm')
  // Controls must be frozen into the prepared config: the dispatcher rejects an
  // options object that differs from what prepareCall resolved.
  const call = await llm.prepareCall(
    {
      provider: route.provider,
      model: route.model,
      maxTokens: tuning.maxTokens,
      temperature: tuning.temperature,
    },
    signal,
    (controls) => ({ ...controls }),
  )
  const options = {
    ...call.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: request }] }],
    system: SYSTEM_PROMPT,
    signal,
  }

  let text = ''
  let usage
  let finish = 'stop'
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'usage') {
      usage = chunk.usage
      continue
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason
      finish = reason.kind
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const failure = reason.failure ?? {}
        const error = new Error(failure.message ?? `model call ${reason.kind}`)
        if (typeof failure.code === 'string') error.code = failure.code
        throw error
      }
    }
  }
  return { prompt: cleanAnswer(text), usage, finish }
}

/**
 * Register the host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - optional overrides.
 */
export function apply(ctx, config = {}) {
  const tuning = {
    maxTokens: Number.isFinite(config?.maxTokens) ? config.maxTokens : DEFAULT_MAX_TOKENS,
    temperature: Number.isFinite(config?.temperature) ? config.temperature : 0.2,
    timeoutMs: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
  }

  const status = (request, response) => {
    if (!sameOrigin(request)) return send(response, 403, { ok: false, error: 'untrusted-origin' })
    send(response, 200, {
      ok: true,
      plugin: NAME,
      build: BUILD,
      maxTokens: tuning.maxTokens,
      temperature: tuning.temperature,
    })
  }

  const refine = async (request, response) => {
    if (!sameOrigin(request)) return send(response, 403, { ok: false, error: 'untrusted-origin' })
    if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method-not-allowed' })

    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch (error) {
      return send(response, 400, { ok: false, error: `bad-request: ${messageOf(error)}` })
    }

    const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined
    let draft = typeof body?.draft === 'string' ? body.draft.trim() : ''
    if (draft.length > MAX_DRAFT_CHARS) draft = draft.slice(0, MAX_DRAFT_CHARS)

    try {
      const route = await resolveRoute(ctx, sessionId)
      if (route === undefined) return send(response, 503, { ok: false, error: 'no-model-route' })

      const turns = await readTurns(ctx, sessionId)
      const transcript = renderTranscript(turns)
      if (transcript.length === 0 && draft.length === 0) {
        return send(response, 400, { ok: false, error: 'nothing-to-refine' })
      }

      const signal = AbortSignal.timeout(tuning.timeoutMs)
      const result = await rewrite(ctx, route, buildRequest(transcript, draft), signal, tuning)
      if (result.prompt.length === 0) return send(response, 502, { ok: false, error: 'empty-completion' })

      send(response, 200, {
        ok: true,
        prompt: result.prompt,
        provider: route.provider,
        model: route.model,
        finish: result.finish,
        usage: result.usage,
      })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : undefined
      ctx.logger?.warn?.('%s: refine failed', NAME, error)
      send(response, 502, { ok: false, error: messageOf(error), code })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_STATUS, handler: status }), `${NAME}: status route`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_REFINE, handler: refine }), `${NAME}: refine route`)

  // The slash command is the headless entry point: it returns the rewritten
  // prompt as message text, so the same logic is reachable without a composer.
  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(
      () =>
        commands.register({
          name: 'refine',
          description: 'Rewrite the given draft into a complete prompt using this conversation.',
          input: { hint: '[draft]' },
          handler: async (invocation) => {
            const sessionId = invocation?.agent?.session?.id
            let draft = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
            if (draft.length > MAX_DRAFT_CHARS) draft = draft.slice(0, MAX_DRAFT_CHARS)
            try {
              const route = await resolveRoute(ctx, sessionId)
              if (route === undefined) return { kind: 'error', text: 'no model route is available for this session' }
              const transcript = renderTranscript(await readTurns(ctx, sessionId))
              if (transcript.length === 0 && draft.length === 0) {
                return { kind: 'error', text: 'nothing to refine: this session has no turns and no draft was given' }
              }
              const signal = invocation?.signal ?? AbortSignal.timeout(tuning.timeoutMs)
              const result = await rewrite(ctx, route, buildRequest(transcript, draft), signal, tuning)
              if (result.prompt.length === 0) return { kind: 'error', text: 'the model returned an empty prompt' }
              return { kind: 'success', text: result.prompt }
            } catch (error) {
              ctx.logger?.warn?.('%s: /refine failed', NAME, error)
              return { kind: 'error', text: messageOf(error) }
            }
          },
        }),
      `${NAME}: refine command`,
    )
  }
}

export const name = NAME
export const inject = ['webServer', 'llm']

/** Pure helpers exposed for the offline test suite. */
export const internals = { sameOrigin, renderTranscript, cleanAnswer, buildRequest, textOfMessage, loopbackAuthority }
