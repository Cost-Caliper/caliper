// src/sse.mjs — tiny SSE channel helper.
//
// Each run gets an SSE channel. Multiple clients may attach to the same run;
// late joiners receive all buffered events and then tail live events.
// A keep-alive comment is sent every 15 seconds to prevent proxy timeouts.

export function createChannel() {
  const clients = new Set()     // Set of ServerResponse objects
  const buffer = []             // All events emitted so far (for late-joiner replay)
  let keepAliveTimer = null

  function emit(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    buffer.push(payload)
    for (const res of clients) {
      try { res.write(payload) } catch { clients.delete(res) }
    }
  }

  function emitRaw(raw) {
    // For keep-alive comments: ': keep-alive\n\n'
    buffer.push(raw)
    for (const res of clients) {
      try { res.write(raw) } catch { clients.delete(res) }
    }
  }

  function attach(res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // Replay buffered events to the late joiner
    for (const payload of buffer) {
      try { res.write(payload) } catch { return }
    }

    clients.add(res)
    res.on('close', () => clients.delete(res))
  }

  function startKeepAlive() {
    keepAliveTimer = setInterval(() => {
      emitRaw(': keep-alive\n\n')
    }, 15_000)
    keepAliveTimer.unref?.()
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }

  function closeAll() {
    stopKeepAlive()
    for (const res of clients) {
      try { res.end() } catch { /* ignore */ }
    }
    clients.clear()
  }

  startKeepAlive()

  return { emit, attach, closeAll, stopKeepAlive, bufferSize: () => buffer.length }
}
