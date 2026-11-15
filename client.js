/**
 * Client half of `dsh-prompt-complete`.
 *
 * One button in the composer tool row. Clicking it sends the live draft plus
 * the session id to the host route, then writes the rewrite back into the
 * composer. Every DOM failure is contained: a throw here would unmount the
 * host composer, so each entry point is wrapped and the button has an
 * error boundary.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-complete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const REFINE_PATH = '/dsh-prompt-complete/refine'
    const TAG = '[dsh-prompt-complete]'
    const UNDO_WINDOW_MS = 12000

    let dictionary

    const DICTS = {
      zh: {
        idle: '完善',
        busy: '完善中',
        titleIdle: '根据本对话完善提示词',
        titleBusy: '正在根据对话改写…',
        done: '已完善',
        undo: '撤销',
        empty: '输入框是空的，会依据对话推断下一条',
        pinned: '输入框含引用，先清空再完善',
        stale: '输入框已变化，结果已放入草稿区之外',
        failed: '完善失败',
      },
      en: {
        idle: 'Refine',
        busy: 'Refining',
        titleIdle: 'Rewrite this draft using the conversation',
        titleBusy: 'Rewriting from the conversation…',
        done: 'Refined',
        undo: 'Undo',
        empty: 'Draft is empty: the next prompt will be inferred',
        pinned: 'Draft has references; clear them first',
        stale: 'Draft changed; result was not applied',
        failed: 'Refine failed',
      },
    }

    /**
     * Pick the dictionary for the current UI language.
     * @returns {object} the active strings.
     */
    function strings() {
      if (dictionary !== undefined) return dictionary
      let zh = false
      try {
        zh = String(globalThis.navigator?.language ?? '').toLowerCase().startsWith('zh')
      } catch {
        zh = false
      }
      dictionary = zh ? DICTS.zh : DICTS.en
      return dictionary
    }

    /**
     * Resolve the live composer input handle for one session.
     * @param {object} ctx - the client plugin context.
     * @param {string} sessionId - the session id.
     * @returns {object | undefined} the input handle.
     */
    function inputOf(ctx, sessionId) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) return undefined
      const conversation = ctx.get('conversation')
      if (conversation === undefined) return undefined
      const scope = sessions.scope(sessionId)
      if (scope === undefined) return undefined
      return conversation.input.for(scope)
    }

    /**
     * Read the current draft from the live composer.
     * @param {object} ctx - the client plugin context.
     * @param {string} sessionId - the session id.
     * @returns {string} the draft.
     */
    function readDraft(ctx, sessionId) {
      try {
        const snapshot = inputOf(ctx, sessionId)?.state?.getSnapshot?.()
        return typeof snapshot?.draft === 'string' ? snapshot.draft : ''
      } catch {
        return ''
      }
    }

    /**
     * Whether the composer holds chips that a whole-draft replacement would drop.
     * @param {object} ctx - the client plugin context.
     * @param {string} sessionId - the session id.
     * @returns {boolean} whether references are attached.
     */
    function hasReferences(ctx, sessionId) {
      try {
        const snapshot = inputOf(ctx, sessionId)?.state?.getSnapshot?.()
        if (snapshot === undefined) return false
        const pinned = snapshot.phase === 'claimed' || snapshot.phase === 'adjudicating'
        const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences.length : 0
        return pinned || occurrences > 0
      } catch {
        return false
      }
    }

    /**
     * Replace the composer draft.
     * @param {object} ctx - the client plugin context.
     * @param {string} sessionId - the session id.
     * @param {string} text - the new draft.
     * @returns {string} one of `ok`, `stale`, `missing`.
     */
    function writeDraft(ctx, sessionId, text) {
      try {
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return 'missing'
        if (typeof input.setDraft !== 'function') return 'missing'
        input.setDraft(text)
        return 'ok'
      } catch (error) {
        console.warn(TAG, 'setDraft failed', error)
        return 'stale'
      }
    }

    /**
     * Ask the host half for one rewrite.
     * @param {string} sessionId - the session id.
     * @param {string} draft - the current draft.
     * @param {AbortSignal} signal - cancellation.
     * @returns {Promise<string>} the rewritten prompt.
     */
    async function requestRefine(sessionId, draft, signal) {
      const fetchImpl = globalThis.fetch
      if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
      const response = await fetchImpl(REFINE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, draft }),
        signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('empty result')
      return prompt
    }

    const STYLE = {
      root: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontFamily: 'var(--dsw-font-family, inherit)',
      },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        fontSize: 'var(--dsw-font-xs, 12px)',
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
      },
      buttonHover: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      buttonBusy: {
        cursor: 'progress',
        color: 'var(--dsw-alias-accent, var(--dsw-alias-brand-primary, inherit))',
        borderColor: 'var(--dsw-alias-accent, var(--dsw-alias-brand-primary, rgba(127,127,127,0.28)))',
      },
      buttonDone: {
        color: 'var(--dsw-alias-state-success-primary, inherit)',
        borderColor: 'var(--dsw-alias-state-success-primary, rgba(127,127,127,0.28))',
      },
      buttonError: {
        color: 'var(--dsw-alias-state-error-primary, inherit)',
        borderColor: 'var(--dsw-alias-state-error-primary, rgba(127,127,127,0.28))',
      },
      undo: {
        padding: '0 6px',
        height: '24px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxs, 11px)',
        cursor: 'pointer',
        textDecoration: 'underline',
        whiteSpace: 'nowrap',
      },
      hint: {
        position: 'absolute',
        bottom: 'calc(100% + 6px)',
        right: 0,
        maxWidth: '320px',
        padding: '4px 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(32,32,32,0.94))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,0.25))',
        fontSize: 'var(--dsw-font-xxs, 11px)',
        lineHeight: 1.4,
        pointerEvents: 'none',
        zIndex: 20,
      },
      spinner: {
        width: '10px',
        height: '10px',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'dsh-prompt-complete-spin 700ms linear infinite',
      },
    }

    /**
     * Sparkle glyph: a pen-tip star marking "rewrite".
     * @param {{ size?: number }} props - the icon size.
     * @returns {object} the element.
     */
    function Glyph(props) {
      const size = (props !== null && typeof props?.size === 'number' ? props.size : 12)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M8 1.6l1.35 3.55L12.9 6.5l-3.55 1.35L8 11.4 6.65 7.85 3.1 6.5l3.55-1.35L8 1.6z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M12.4 10.6l.6 1.55 1.55.6-1.55.6-.6 1.55-.6-1.55L10.25 12.75l1.55-.6.6-1.55z',
          fill: 'currentColor',
          opacity: '0.7',
        }),
      )
    }

    /**
     * The refine control.
     * @param {object} props - slot props.
     * @returns {object} the element.
     */
    function RefineControl(props) {
      const safe = props !== null && typeof props === 'object' ? props : {}
      const ctx = safe.ctx ?? safe.pluginContext ?? RefineControl.ctx
      const sessionId = typeof safe.sessionId === 'string' ? safe.sessionId : undefined

      const [phase, setPhase] = React.useState('idle')
      const [hovered, setHovered] = React.useState(false)
      const [hint, setHint] = React.useState(undefined)
      const [undo, setUndo] = React.useState(undefined)
      const abortRef = React.useRef(undefined)
      const timerRef = React.useRef(undefined)
      const mountedRef = React.useRef(true)

      const t = strings()

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
          if (abortRef.current !== undefined) {
            try {
              abortRef.current.abort()
            } catch {
              // An abort that throws is already aborted.
            }
          }
        }
      }, [])

      const flash = React.useCallback((text, ms) => {
        setHint(text)
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined
          if (mountedRef.current) setHint(undefined)
        }, ms ?? 3200)
      }, [])

      const onClick = React.useCallback(
        (event) => {
          try {
            event?.preventDefault?.()
            event?.stopPropagation?.()
          } catch {
            // Non-DOM callers are fine.
          }
          if (phase === 'busy') {
            if (abortRef.current !== undefined) {
              try {
                abortRef.current.abort()
              } catch {
                // Already aborted.
              }
            }
            return
          }
          if (ctx === undefined || sessionId === undefined) {
            setPhase('error')
            flash(t.failed)
            return
          }

          const before = readDraft(ctx, sessionId)
          if (hasReferences(ctx, sessionId)) {
            setPhase('error')
            flash(t.pinned)
            return
          }

          const controller = typeof AbortController === 'function' ? new AbortController() : undefined
          abortRef.current = controller
          setPhase('busy')
          setHint(before.length === 0 ? t.empty : undefined)

          requestRefine(sessionId, before, controller?.signal)
            .then((prompt) => {
              if (!mountedRef.current) return
              const now = readDraft(ctx, sessionId)
              if (now !== before) {
                setPhase('error')
                flash(t.stale)
                return
              }
              const outcome = writeDraft(ctx, sessionId, prompt)
              if (outcome !== 'ok') {
                setPhase('error')
                flash(t.failed)
                return
              }
              setPhase('done')
              setUndo({ text: before })
              if (timerRef.current !== undefined) clearTimeout(timerRef.current)
              timerRef.current = setTimeout(() => {
                timerRef.current = undefined
                if (mountedRef.current) {
                  setPhase('idle')
                  setUndo(undefined)
                }
              }, UNDO_WINDOW_MS)
            })
            .catch((error) => {
              if (!mountedRef.current) return
              if (error?.name === 'AbortError') {
                setPhase('idle')
                setHint(undefined)
                return
              }
              console.warn(TAG, 'refine failed', error)
              setPhase('error')
              flash(`${t.failed}: ${error instanceof Error ? error.message : String(error)}`, 6000)
            })
            .finally(() => {
              abortRef.current = undefined
            })
        },
        [ctx, sessionId, phase, t, flash],
      )

      const onUndo = React.useCallback(
        (event) => {
          try {
            event?.preventDefault?.()
            event?.stopPropagation?.()
          } catch {
            // Non-DOM callers are fine.
          }
          if (ctx === undefined || sessionId === undefined || undo === undefined) return
          writeDraft(ctx, sessionId, undo.text)
          setUndo(undefined)
          setPhase('idle')
        },
        [ctx, sessionId, undo],
      )

      const style = { ...STYLE.button }
      if (phase === 'busy') Object.assign(style, STYLE.buttonBusy)
      else if (phase === 'done') Object.assign(style, STYLE.buttonDone)
      else if (phase === 'error') Object.assign(style, STYLE.buttonError)
      else if (hovered) Object.assign(style, STYLE.buttonHover)

      const label = phase === 'busy' ? t.busy : phase === 'done' ? t.done : t.idle
      const title = phase === 'busy' ? t.titleBusy : t.titleIdle

      return h(
        'div',
        { style: STYLE.root, 'data-dsh-prompt-complete': phase },
        hint !== undefined
          ? h('div', { style: STYLE.hint, role: 'status' }, hint)
          : null,
        h(
          'button',
          {
            type: 'button',
            title,
            'aria-label': title,
            'aria-busy': phase === 'busy' ? 'true' : 'false',
            disabled: false,
            style,
            onClick,
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          },
          phase === 'busy' ? h('span', { style: STYLE.spinner }) : h(Glyph, { size: 12 }),
          h('span', null, label),
        ),
        undo !== undefined
          ? h('button', { type: 'button', style: STYLE.undo, onClick: onUndo }, t.undo)
          : null,
      )
    }

    /**
     * Contain any render failure so the host composer survives.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.warn(TAG, 'control crashed', error)
      }

      render() {
        if (this.state.failed) return null
        return this.props.children
      }
    }

    /**
     * Wrap the control in its error boundary.
     * @param {object} props - slot props.
     * @returns {object} the element.
     */
    function Mount(props) {
      return h(Boundary, null, h(RefineControl, props))
    }

    /**
     * Keyframe for the busy spinner; injected once per page.
     */
    function ensureKeyframes() {
      try {
        const id = 'dsh-prompt-complete-keyframes'
        if (document.getElementById(id) !== null) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = '@keyframes dsh-prompt-complete-spin{to{transform:rotate(360deg)}}'
        document.head.appendChild(style)
      } catch (error) {
        console.warn(TAG, 'keyframes injection failed', error)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          RefineControl.ctx = ctx
          ensureKeyframes()
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: 'prompt-complete',
                order: 60,
                label: 'Refine prompt',
              },
              Mount,
            ),
          )
        } catch (error) {
          console.warn(TAG, 'slot registration failed', error)
        }
      },
    }
  },
})
