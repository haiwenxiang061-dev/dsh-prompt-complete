import assert from 'node:assert/strict'
import test from 'node:test'

import { internals, name, inject } from '../lib/index.js'

const { sameOrigin, renderTranscript, cleanAnswer, buildRequest, textOfMessage } = internals

/** Build a fake IncomingMessage with the given headers. */
function request(headers) {
  return { headers, method: 'POST' }
}

test('manifest exports the plugin identity', () => {
  assert.equal(name, 'dsh-prompt-complete')
  assert.deepEqual(inject, ['webServer', 'llm'])
})

test('sameOrigin accepts loopback without an Origin header', () => {
  assert.equal(sameOrigin(request({ host: '127.0.0.1:57820' })), true)
  assert.equal(sameOrigin(request({ host: 'localhost:3000' })), true)
  assert.equal(sameOrigin(request({ host: '[::1]:8080' })), true)
})

test('sameOrigin rejects non-loopback hosts', () => {
  assert.equal(sameOrigin(request({ host: 'evil.example.com' })), false)
  assert.equal(sameOrigin(request({ host: '10.0.0.5:57820' })), false)
})

test('sameOrigin rejects cross-site and mismatched origins', () => {
  assert.equal(sameOrigin(request({ host: '127.0.0.1:57820', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:57820', origin: 'http://evil.example.com' })), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:57820', origin: 'http://127.0.0.1:57820' })), true)
})

test('textOfMessage joins text blocks only', () => {
  assert.equal(textOfMessage({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(textOfMessage({ content: [{ type: 'image', attachment: {} }] }), '')
  assert.equal(textOfMessage(undefined), '')
})

test('renderTranscript keeps the tail inside the char budget', () => {
  const turns = Array.from({ length: 40 }, (_v, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index} `.repeat(20),
  }))
  const transcript = renderTranscript(turns)
  assert.ok(transcript.includes('[user]'))
  assert.ok(transcript.length <= 14000 + 200)
})

test('renderTranscript truncates a single oversized turn', () => {
  const transcript = renderTranscript([{ role: 'user', text: 'x'.repeat(5000) }])
  assert.ok(transcript.includes('[truncated]'))
  assert.ok(transcript.length < 5000)
})

test('cleanAnswer strips one wrapping code fence', () => {
  assert.equal(cleanAnswer('```md\nhello\n```'), 'hello')
  assert.equal(cleanAnswer('```\nhello\n```'), 'hello')
  assert.equal(cleanAnswer('  plain  '), 'plain')
})

test('cleanAnswer leaves inner fences alone', () => {
  const answer = 'line one\n\n```js\ncode()\n```'
  assert.equal(cleanAnswer(answer), answer)
})

test('buildRequest frames an empty draft distinctly', () => {
  const empty = buildRequest('', '')
  assert.ok(empty.includes('(no prior turns)'))
  assert.ok(empty.includes('(empty)'))
  assert.ok(empty.includes('inferred from the open work'))

  const withDraft = buildRequest('[user] hi', 'do the thing')
  assert.ok(withDraft.includes('<<<DRAFT>>>\ndo the thing'))
  assert.ok(withDraft.includes('Rewrite the draft'))
})
