/**
 * Offline execution of the Host half.
 *
 * Mounts `apply()` against a stub Context and asserts the plugin claims
 * exactly the surfaces it documents: two web routes, one slash command, and no
 * registration outside `ctx.effect`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { apply, name, inject } = await import('../lib/index.js')

/**
 * Build a Context stub that records every registration.
 * @param {object} [options] - overrides.
 * @param {object} [options.services] - service map returned by `ctx.get()`.
 * @param {boolean} [options.withCommands] - whether a command registry exists.
 * @returns {object} the stub context plus its records.
 */
function mount(options = {}) {
  const routes = []
  const commands = []
  const effects = []
  const services = options.services ?? {}

  const ctx = {
    get(key) {
      if (key === 'commands') {
        if (options.withCommands === false) return undefined
        return {
          register(definition) {
            commands.push(definition)
            return () => {}
          },
        }
      }
      return services[key]
    },
    effect(factory, label) {
      effects.push(label)
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn() {}, info() {}, debug() {} },
  }

  apply(ctx, {})

  return { ctx, routes, commands, effects }
}

test('exposes the documented plugin identity', () => {
  assert.equal(name, 'dsh-prompt-complete')
  assert.deepEqual(inject, ['webServer', 'llm'])
})

test('registers the status and refine routes as exact paths', () => {
  const { routes } = mount()
  const paths = routes.map((route) => `${route.kind} ${route.path}`).sort()
  assert.deepEqual(paths, ['exact /dsh-prompt-complete/refine', 'exact /dsh-prompt-complete/status'])
  assert.ok(routes.every((route) => typeof route.handler === 'function'))
})

test('registers one slash command reachable without the composer', () => {
  const { commands } = mount()
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'refine')
  assert.equal(typeof commands[0].handler, 'function')
})

test('skips the slash command when the registry is absent', () => {
  const { commands, routes } = mount({ services: {}, withCommands: false })
  assert.equal(commands.length, 0)
  assert.equal(routes.length, 2)
})

test('every registration goes through ctx.effect', () => {
  const { effects } = mount()
  assert.deepEqual(effects, [
    'dsh-prompt-complete: status route',
    'dsh-prompt-complete: refine route',
    'dsh-prompt-complete: refine command',
  ])
})

test('the slash command reports a missing route instead of throwing', async () => {
  const { commands } = mount()
  const result = await commands[0].handler({ rawInput: 'draft', agent: { session: { id: 'session-x' } } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no model route/)
})

test('the slash command reports an empty session without a draft', async () => {
  const { commands } = mount()
  const result = await commands[0].handler({ rawInput: '   ', agent: { session: { id: 'session-x' } } })
  assert.equal(result.kind, 'error')
})

test('the routes reject a cross-site request before touching the model', async () => {
  const { routes } = mount()
  const status = routes.find((route) => route.path.endsWith('/status'))
  let status0
  let payload

  status.handler(
    { headers: { host: '127.0.0.1:57820', 'sec-fetch-site': 'cross-site' }, method: 'GET' },
    {
      headersSent: false,
      writableEnded: false,
      writeHead(code) {
        status0 = code
      },
      end(body) {
        payload = JSON.parse(body)
      },
    },
  )

  assert.equal(status0, 403)
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'untrusted-origin')
})

test('the status route reports the running build', () => {
  const { routes } = mount()
  const status = routes.find((route) => route.path.endsWith('/status'))
  let payload

  status.handler(
    { headers: { host: '127.0.0.1:57820' }, method: 'GET' },
    {
      headersSent: false,
      writableEnded: false,
      writeHead() {},
      end(body) {
        payload = JSON.parse(body)
      },
    },
  )

  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-prompt-complete')
  assert.equal(typeof payload.build, 'string')
  assert.equal(typeof payload.maxTokens, 'number')
})
