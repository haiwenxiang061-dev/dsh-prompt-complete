/**
 * Offline execution of the Client half.
 *
 * Loads `client.js` the same way the Web host does — through
 * `window.__ModuleLoader__.load({ id, factory })` — with a minimal React stub,
 * then asserts the module registers exactly one slot entry and that rendering
 * the registered component produces markup without throwing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Build the smallest React surface the bundle touches.
 * @returns {object} a React-shaped stub plus the element tree it records.
 */
function fakeReact() {
  const calls = []

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...next }
    }
  }

  const React = {
    Component,
    createElement(type, props, ...children) {
      const flat = children.flat().filter((child) => child !== null && child !== undefined)
      // React puts children on props; the stub must do the same so function and
      // class components receive the same shape they get in the browser.
      const merged = { ...(props ?? {}) }
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      const node = { type, props: merged, children: flat }
      calls.push(node)
      return node
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }

  return { React, calls }
}

/**
 * Execute client.js against a fake host.
 * @returns {{ registration: object | undefined, plugin: object }} the captured registration.
 */
function load() {
  const { React } = fakeReact()
  let captured

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, plugin: factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require("${name}")`)
        }) }
      },
    },
  }

  // eslint-disable-next-line no-new-func -- the bundle is an ES module body run in a script scope
  new Function(source)()

  return captured
}

test('client half loads through __ModuleLoader__ with the package id', () => {
  const loaded = load()
  assert.equal(loaded.id, 'dsh-prompt-complete')
})

test('client half declares slots as its only injection', () => {
  const loaded = load()
  assert.deepEqual(loaded.plugin.inject, ['slots'])
  assert.equal(typeof loaded.plugin.apply, 'function')
})

test('apply registers one entry on conversation.input.right', () => {
  const loaded = load()
  const registrations = []
  let injectedInto

  const ctx = {
    get: () => undefined,
    slots: {
      inject(slot, factory) {
        injectedInto = slot
        return factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  loaded.plugin.apply(ctx)

  assert.equal(injectedInto, 'conversation.input.right')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'conversation.input.right')
  assert.equal(registrations[0].options.id, 'prompt-complete')
  assert.equal(registrations[0].options.order, 60)
  assert.equal(typeof registrations[0].component, 'function')
})

/**
 * Expand a recorded element tree through class and function components.
 * @param {object} node - an element produced by the stub `createElement`.
 * @param {number} [depth] - recursion guard.
 * @returns {object} the expanded tree.
 */
function expand(node, depth = 0) {
  if (depth > 12) throw new Error('component tree did not settle')
  if (node === null || typeof node !== 'object') return node
  const type = node.type
  if (typeof type === 'function') {
    const isClass = type.prototype !== undefined && typeof type.prototype.render === 'function'
    const rendered = isClass ? new type(node.props).render() : type(node.props)
    return expand(rendered, depth + 1)
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, depth + 1)) }
}

test('the registered component renders without a session context', () => {
  const loaded = load()
  let component

  loaded.plugin.apply({
    get: () => undefined,
    slots: {
      inject: (_slot, factory) => factory(),
      register: (_options, registered) => {
        component = registered
        return () => {}
      },
    },
  })

  const tree = expand(component({}))
  assert.ok(tree !== undefined && tree !== null, 'component must return an element')
  assert.equal(tree.type, 'div')
  assert.equal(tree.props['data-dsh-prompt-complete'], 'idle')

  const button = tree.children.find((child) => child?.type === 'button')
  assert.ok(button !== undefined, 'the control must render a button')
  assert.equal(button.props.type, 'button')
  assert.equal(typeof button.props.onClick, 'function')
})

test('apply survives a broken slot registry', () => {
  const loaded = load()
  assert.doesNotThrow(() => {
    loaded.plugin.apply({
      get: () => undefined,
      slots: {
        inject() {
          throw new Error('slot registry exploded')
        },
      },
    })
  })
})
