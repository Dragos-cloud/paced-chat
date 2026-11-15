import * as sdk from '@hermes/plugin-sdk'
import { Component, createElement as h, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

const { host, PALETTE_AREA, KEYBINDS_AREA, MessageTextContent } = sdk
const ID = 'paced-chat'
const NAME = 'Paced Chat'
const MIN_WPM = 90
const MAX_WPM = 600
const DEFAULT_WPM = 240

function validSpeed(value) {
  return Number.isInteger(value) && value >= MIN_WPM && value <= MAX_WPM
}

function messageRows(result) {
  if (!Array.isArray(result?.messages)) throw new Error('Hermes did not return the conversation history.')
  return result.messages.flatMap((message, index) => {
    if (!message || message.display_kind === 'hidden') return []
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text = message.text ?? message.content
    if (typeof text !== 'string' || !text.trim()) return []
    return [{ id: `history-${index}`, role: message.role, text }]
  })
}

function completeText(received, finalText) {
  if (!finalText || received === finalText) return received
  if (!received || finalText.startsWith(received)) return finalText
  const trimmed = received.trimEnd()
  const final = finalText.trim()
  if (trimmed.endsWith(final)) return received
  // After tool calls, Hermes can supply just the final answer in the terminal event.
  const lastParagraph = trimmed.lastIndexOf('\n\n') + 2
  if (lastParagraph > 1 && final.startsWith(trimmed.slice(lastParagraph))) {
    return trimmed.slice(0, lastParagraph) + final
  }
  return `${trimmed}\n\n${finalText}`
}

function createChat(ctx, target) {
  const listeners = new Set()
  const disposers = []
  let sessionId = target.sessionId
  let storedId = target.storedId
  let disposed = false
  let stale = false
  let loading = Boolean(sessionId)
  let notice = ''
  let rows = []
  let draft = ''
  let active = null
  let timer = 0
  let serial = 0
  let snapshot
  const savedSpeed = ctx.storage.get('wordsPerMinute', DEFAULT_WPM)
  let speed = validSpeed(savedSpeed) ? savedSpeed : DEFAULT_WPM

  function publish() {
    snapshot = {
      rows, speed, draft, loading, stale, notice, storedId, connectionChanged: !sameGateway(),
      busy: Boolean(active),
      generating: Boolean(active?.submitted && !active.done),
      canStop: Boolean(active?.accepted && !active.queued && !active.done && !active.stopping && !stale),
      canCatchUp: Boolean(active?.received && !active.follow && !stale),
      reply: active ? { id: active.replyId, role: 'assistant', text: active.shown } : null,
      status: loading ? 'Loading conversation…' : active?.stopping ? 'Stopping…' :
        active?.done ? 'Reading at your pace…' : active?.queued ? 'Queued in Hermes…' :
        active?.follow ? 'Following the live reply…' :
        active?.shown ? 'Hermes is replying…' : active ? 'Waiting for Hermes…' : '',
    }
    for (const listener of listeners) listener()
  }

  function sameGateway() {
    return host.state.profile.get() === target.profile &&
      host.state.connectionId?.get() === target.connectionId &&
      host.state.gateway.get() === 'open'
  }

  function markStale() {
    if (disposed || stale) return
    stale = true
    loading = false
    clearTimeout(timer)
    if (active?.received) {
      rows = [...rows, { id: active.replyId, role: 'assistant', text: active.received }]
    }
    active = null
    notice = 'The Hermes connection changed. Close this tab and reopen Paced Chat from the conversation to continue.'
    publish()
  }

  function settle(turn) {
    if (turn.shown !== turn.received || !turn.done || !turn.acknowledged) return
    if (turn.shown) rows = [...rows, { id: turn.replyId, role: 'assistant', text: turn.shown }]
    active = null
    if (!notice && !turn.shown) notice = 'Hermes finished without returning reply text.'
  }

  function pace(turn) {
    if (disposed || active !== turn) return
    clearTimeout(timer)
    if (turn.follow) {
      turn.shown = turn.received
    } else {
      let tail = turn.received.slice(turn.shown.length)
      // Hermes can split a word across multiple deltas. Finish the word already visible.
      const continuation = /\S$/u.test(turn.shown) ? /^\S+/u.exec(tail)?.[0] : ''
      if (continuation) {
        turn.shown += continuation
        tail = tail.slice(continuation.length)
      }
      const word = /^\s*\S+/u.exec(tail)?.[0]
      if (word) {
        const now = performance.now()
        const interval = 60000 / speed
        const delay = turn.lastWordAt + interval - now
        if (delay > 0) {
          timer = setTimeout(() => pace(turn), Math.ceil(delay))
        } else {
          turn.shown += word
          turn.lastWordAt = now
          tail = tail.slice(word.length)
          if (/\S/u.test(tail)) timer = setTimeout(() => pace(turn), Math.ceil(interval))
        }
      }
      if (turn.done && !/\S/u.test(turn.received.slice(turn.shown.length))) {
        turn.shown = turn.received
      }
    }
    settle(turn)
    publish()
  }

  function onEvent(event) {
    const turn = active
    if (disposed || stale || !turn?.submitted || turn.done || !sameGateway()) return
    if (event?.session_id !== sessionId || event.payload?.subagent_id) return
    const payload = event.payload ?? {}
    if (turn.admissionId && payload.admission_id && turn.admissionId !== payload.admission_id) return
    if (turn.turnId && payload.turn_id && turn.turnId !== payload.turn_id) return
    switch (event.type) {
      case 'message.start':
        turn.turnId = payload.turn_id ?? turn.turnId
        turn.queued = false
        publish()
        break
      case 'message.delta':
        if (typeof payload.text !== 'string' || !payload.text) return
        turn.turnId = payload.turn_id ?? turn.turnId
        turn.queued = false
        turn.received += payload.text
        pace(turn)
        break
      case 'message.complete':
        turn.received = completeText(turn.received, typeof payload.text === 'string' ? payload.text : '')
        turn.done = true
        turn.stopping = false
        if (payload.status === 'interrupted' || payload.status === 'cancelled' || payload.status === 'stopped') {
          notice = 'Generation stopped.'
        } else if (payload.status === 'error' || payload.status === 'failed') {
          notice = 'Hermes ended the reply with an error.'
        }
        pace(turn)
        break
      case 'error':
        // A session error can also describe a tool. Only explicit terminal failures end a turn here.
        if (payload.terminal === true) {
          notice = typeof payload.message === 'string' ? payload.message : 'Hermes ended the reply with an error.'
          turn.done = true
          turn.stopping = false
          pace(turn)
        }
        break
    }
  }

  function checkConnection() {
    if (!sameGateway()) markStale()
  }

  async function loadHistory() {
    if (!sessionId) return
    try {
      let result
      try {
        result = await host.request('session.history', { session_id: sessionId })
      } catch (error) {
        // A focused runtime id can be gone (gateway restarted, or the conversation was
        // restored from history and never attached). session.resume takes the STORED id
        // and returns a live pair, so re-attach rather than bricking the pane.
        if (!storedId) throw error
        const resumed = await host.request('session.resume', { session_id: storedId })
        if (disposed || stale) return
        if (!resumed?.session_id) throw error
        sessionId = resumed.session_id
        storedId = resumed.stored_session_id ?? storedId
        result = await host.request('session.history', { session_id: sessionId })
      }
      if (disposed || stale) return
      rows = messageRows(result)
    } catch (error) {
      if (disposed || stale) return
      // Unreadable history must not block sending: drop the dead binding so Send
      // starts a new conversation, and say so plainly.
      sessionId = null
      notice = 'Couldn\'t load the earlier messages. Sending starts a new conversation.'
    } finally {
      if (!disposed) {
        loading = false
        publish()
      }
    }
  }

  async function send() {
    const text = draft.trim()
    if (disposed || stale || loading || active || !text) return
    if (!sameGateway()) return markStale()
    if (sessionId && host.state.busyBySession?.get()?.[sessionId]) {
      notice = 'This conversation is already running in Hermes. Wait for the reply to finish, then send again.'
      publish()
      return
    }
    const turn = {
      userId: `user-${++serial}`, replyId: `reply-${serial}`,
      received: '', shown: '', lastWordAt: -Infinity, follow: false,
      submitted: false, accepted: false, acknowledged: false, done: false, stopping: false,
      turnId: null, admissionId: null, queued: false,
    }
    active = turn
    notice = ''
    draft = ''
    rows = [...rows, { id: turn.userId, role: 'user', text }]
    publish()

    try {
      if (!sessionId) {
        const result = await host.request('session.create', { source: 'desktop', cols: 96 })
        if (disposed || active !== turn) return
        if (!sameGateway()) return markStale()
        if (!result?.session_id || !result?.stored_session_id) throw new Error('Hermes did not create a chat session.')
        sessionId = result.session_id
        storedId = result.stored_session_id
      }
      // Set this before calling RPC. A fast reply may arrive before the submission ACK.
      turn.submitted = true
      publish()
      const result = await host.request('prompt.submit', { session_id: sessionId, text, input_id: crypto.randomUUID() })
      if (disposed || active !== turn) return
      turn.acknowledged = true
      turn.admissionId = result?.admission_id ?? null
      if (result?.forwarded || result?.status === 'steered' || result?.status === 'redirected') {
        active = null
        stale = true
        notice = 'Hermes routed this message to a running turn. Open the conversation in Hermes to see where it went.'
      } else if (result?.voice_stopped || result?.status === 'stopped' || result?.status === 'interrupted' || result?.status === 'idle') {
        turn.done = true
        notice = 'There is no reply to display.'
      } else {
        turn.accepted = true
        turn.queued = result?.status === 'queued' && !turn.done && !turn.received && !turn.turnId
      }
      if (active === turn) pace(turn)
      else publish()
    } catch (error) {
      if (disposed || active !== turn) return
      const details = error.message ?? String(error)
      if (turn.received || turn.done || turn.turnId) {
        turn.acknowledged = true
        turn.accepted = true
        pace(turn)
      } else {
        clearTimeout(timer)
        active = null
        draft = draft ? `${text}\n\n${draft}` : text
        rows = rows.filter(row => row.id !== turn.userId)
        notice = `Couldn't confirm that Hermes received the message. ${details}`
        // A lost RPC response can mean that a prompt was already executed. Check history before retrying.
        if (turn.submitted) {
          stale = true
          notice += ' Open the conversation in Hermes to check before resending.'
        }
        publish()
      }
    }
  }

  async function stop() {
    const turn = active
    if (!snapshot.canStop || !turn) return
    if (!sameGateway()) return markStale()
    turn.stopping = true
    publish()
    try {
      const result = await host.request('session.interrupt', { session_id: sessionId })
      if (disposed || active !== turn || turn.done) return
      if (result?.status === 'not_interrupted') {
        turn.stopping = false
        notice = 'Hermes did not find a running reply to stop.'
        publish()
      }
    } catch (error) {
      if (disposed || active !== turn || turn.done) return
      turn.stopping = false
      notice = `Couldn't stop the reply. ${error.message ?? ''}`
      publish()
    }
  }

  function newChat() {
    if (disposed || active || loading) return
    if (!sameGateway()) return markStale()
    sessionId = null
    storedId = null
    stale = false
    rows = []
    draft = ''
    notice = ''
    publish()
  }

  publish()
  disposers.push(host.onEvent('*', onEvent))
  disposers.push(host.state.profile.subscribe(checkConnection), host.state.gateway.subscribe(checkConnection))
  if (host.state.connectionId) disposers.push(host.state.connectionId.subscribe(checkConnection))
  void loadHistory()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setDraft(value) {
      draft = value
      publish()
    },
    setSpeed(value) {
      if (!validSpeed(value)) return
      speed = value
      ctx.storage.set('wordsPerMinute', value)
      if (active) pace(active)
      else publish()
    },
    showAll() {
      if (!snapshot.canCatchUp || !active) return
      active.follow = true
      pace(active)
    },
    send,
    stop,
    newChat,
    openNative() {
      if (storedId && sameGateway()) host.openSession(storedId, { profile: target.profile, intent: 'in-place' })
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      for (const dispose of disposers) dispose()
      listeners.clear()
    },
  }
}

const styles = `
  .hermes-paced-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; width: 100%; color: var(--ui-text-primary); }
  .hermes-paced-chat * { box-sizing: border-box; }
  .hermes-paced-chat__bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; padding: 12px 18px; border-bottom: 1px solid var(--ui-stroke-secondary); }
  .hermes-paced-chat__group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .hermes-paced-chat__speed { display: grid; grid-template-columns: minmax(130px, 200px); }
  .hermes-paced-chat__speed-label { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 2px 10px; font-size: .8rem; }
  .hermes-paced-chat__speed input { width: 100%; margin: 2px 0; accent-color: var(--ui-accent); }
  .hermes-paced-chat__speed output { color: var(--ui-text-secondary); font-variant-numeric: tabular-nums; }
  .hermes-paced-chat__scroll { min-height: 0; flex: 1; overflow: auto; }
  .hermes-paced-chat__body, .hermes-paced-chat__form { width: min(100%, 760px); margin: auto; padding: 14px 18px; }
  .hermes-paced-chat__row { margin-bottom: 20px; overflow-wrap: anywhere; min-width: 0; }
  .hermes-paced-chat__row--user { max-width: 88%; width: fit-content; margin-left: auto; padding: 9px 13px; border-radius: 12px 12px 3px 12px; background: var(--ui-chat-bubble-background, var(--ui-bg-tertiary)); }
  .hermes-paced-chat__label { margin: 0 0 5px; color: var(--ui-text-secondary); font-size: .8rem; font-weight: 500; }
  .hermes-paced-chat__plain { white-space: pre-wrap; }
  .hermes-paced-chat__reply { overflow-x: auto; }
  .hermes-paced-chat__form-wrap { border-top: 1px solid var(--ui-stroke-secondary); }
  .hermes-paced-chat__composer { display: flex; align-items: flex-end; gap: 8px; }
  .hermes-paced-chat__composer textarea { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; resize: vertical; font: inherit; color: inherit; background: var(--ui-bg-elevated); }
  .hermes-paced-chat button { white-space: nowrap; border: 1px solid var(--ui-stroke-secondary); border-radius: 7px; padding: 5px 10px; font: inherit; color: inherit; background: var(--ui-bg-elevated); }
  .hermes-paced-chat button:enabled:hover { background: var(--ui-control-active-background); }
  .hermes-paced-chat button:disabled { opacity: .5; }
  .hermes-paced-chat__status { min-height: 1.2em; margin-top: 5px; overflow-wrap: anywhere; font-size: .8rem; color: var(--ui-text-secondary); }
  .hermes-paced-chat__empty { margin: 5px 0; color: var(--ui-text-secondary); }
  @media (pointer: coarse) { .hermes-paced-chat button, .hermes-paced-chat__speed input { min-height: 44px; } }
`

class MessageBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function ChatRow({ row }) {
  const isUser = row.role === 'user'
  const plain = h('div', { className: 'hermes-paced-chat__plain' }, row.text)
  return h('article', { className: `hermes-paced-chat__row${isUser ? ' hermes-paced-chat__row--user' : ''}` },
    h('h3', { className: 'hermes-paced-chat__label' }, isUser ? 'You' : 'Hermes'),
    h('div', { className: 'hermes-paced-chat__reply' },
      !isUser && MessageTextContent
        ? h(MessageBoundary, { fallback: plain }, h(MessageTextContent, { text: row.text, media: false, previewOnly: true }))
        : plain))
}

function ChatPane({ chat }) {
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const slider = useId()
  const viewport = useRef(null)
  const following = useRef(true)
  const message = useRef(null)
  const rows = state.reply?.text ? [...state.rows, state.reply] : state.rows
  const canSend = !state.loading && !state.stale && !state.busy && Boolean(state.draft.trim())

  useLayoutEffect(() => {
    if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [state.rows, state.reply?.text])

  function send(event) {
    event.preventDefault()
    if (!canSend) return
    following.current = true
    void chat.send()
    message.current?.focus()
  }

  return h('section', { className: 'hermes-paced-chat', 'aria-label': NAME },
    h('style', null, styles),
    h('header', { className: 'hermes-paced-chat__bar' },
      h('div', { className: 'hermes-paced-chat__group' },
        h('div', { className: 'hermes-paced-chat__speed' },
          h('div', { className: 'hermes-paced-chat__speed-label' },
            h('label', { htmlFor: slider }, 'Reading speed'),
            h('output', { htmlFor: slider }, `${state.speed} words/min`)),
          h('input', {
            id: slider, type: 'range', min: MIN_WPM, max: MAX_WPM, step: 10, value: state.speed,
            'aria-valuetext': `${state.speed} words per minute`,
            onChange: event => chat.setSpeed(Number(event.currentTarget.value)),
          })),
        h('button', { type: 'button', disabled: !state.canCatchUp, onClick: chat.showAll }, 'Show all')),
      h('div', { className: 'hermes-paced-chat__group' },
        h('button', { type: 'button', disabled: state.busy || state.loading || state.stale, onClick: chat.newChat }, 'New chat'),
        state.storedId && h('button', { type: 'button', disabled: state.connectionChanged, onClick: chat.openNative }, 'Open in Hermes'))),
    h('div', {
      className: 'hermes-paced-chat__scroll', ref: viewport, 'aria-label': 'Conversation',
      onScroll: event => {
        const view = event.currentTarget
        following.current = view.scrollHeight - view.scrollTop - view.clientHeight < 64
      },
    }, h('div', { className: 'hermes-paced-chat__body' },
      rows.map(row => h(ChatRow, { key: row.id, row })),
      !rows.length && !state.loading && !state.stale &&
        h('p', { className: 'hermes-paced-chat__empty' }, 'Send a message to start a Hermes conversation.'))),
    h('div', { className: 'hermes-paced-chat__form-wrap' },
      h('form', { className: 'hermes-paced-chat__form', onSubmit: send },
        h('div', { className: 'hermes-paced-chat__composer' },
          h('textarea', {
            rows: 2, ref: message, value: state.draft, placeholder: 'Message Hermes', 'aria-label': 'Message Hermes',
            onChange: event => chat.setDraft(event.currentTarget.value),
            onKeyDown: event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              send(event)
            },
          }),
          state.generating && h('button', { type: 'button', disabled: !state.canStop, onClick: chat.stop }, 'Stop'),
          h('button', { type: 'submit', disabled: !canSend }, 'Send')),
        h('div', { className: 'hermes-paced-chat__status', role: 'status' },
          state.notice || state.status))))
}

export default {
  id: ID,
  name: NAME,
  register(ctx) {
    let workspace = null

    function open() {
      if (typeof host.openWorkspace !== 'function') {
        host.notify({ kind: 'warning', message: 'Paced Chat needs a Hermes Desktop build with workspace plug-in tabs.' })
        return
      }
      if (workspace) {
        workspace.open()
        return
      }
      if (host.state.gateway.get() !== 'open') {
        host.notify({ kind: 'warning', message: 'Connect Hermes to a gateway, then open Paced Chat.' })
        return
      }
      const profile = host.state.profile.get()
      const connectionId = host.state.connectionId?.get()
      const ownerConnectionId = host.state.focusedSessionOwner?.get()?.connectionId
      const focusedProfile = host.state.focusedSessionProfile?.get()
      if ((focusedProfile && focusedProfile !== profile) ||
          (ownerConnectionId && connectionId && ownerConnectionId !== connectionId)) {
        host.notify({ kind: 'warning', message: 'Open this conversation in its own profile before opening Paced Chat.' })
        return
      }
      const storedId = host.state.focusedStoredSessionId?.get() ?? null
      const sessionId = storedId
        ? (host.state.focusedSessionId?.get() ?? host.state.activeSessionId.get()) : null
      if (storedId && !sessionId) {
        host.notify({ kind: 'warning', message: 'Wait for Hermes to open the conversation, then try Paced Chat again.' })
        return
      }
      if (sessionId && (host.state.busyBySession?.get()?.[sessionId] || host.state.busy.get())) {
        host.notify({ kind: 'warning', message: 'Wait for the current Hermes reply to finish, then open Paced Chat.' })
        return
      }
      const chat = createChat(ctx, { profile, connectionId, sessionId, storedId })
      const entry = {
        close: null,
        open() {
          entry.close = host.openWorkspace(ID, {
            title: NAME,
            minWidth: '320px',
            render: () => h(ChatPane, { chat }),
            onClose() {
              chat.dispose()
              if (workspace === entry) workspace = null
            },
          })
        },
      }
      workspace = entry
      try {
        entry.open()
      } catch (error) {
        workspace = null
        chat.dispose()
        throw error
      }
    }

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: { id: `${ID}.open`, label: 'Open Paced Chat', keywords: ['reading', 'speed', 'pace'], run: open },
    })
    ctx.register({
      id: 'status-chip',
      area: 'statusBar.right',
      render: () => h('button', {
        type: 'button',
        className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
        onClick: open,
      }, NAME),
    })
    if (KEYBINDS_AREA) {
      ctx.register({
        id: 'open-keybind',
        area: KEYBINDS_AREA,
        data: { id: `${ID}.open`, label: 'Open Paced Chat', run: open },
      })
    }
    ctx.onDispose(() => workspace?.close?.())
  },
}
