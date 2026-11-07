import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

/** Run a CLI in its own POSIX process group and wait for termination on cancellation. */
export async function runChild({ bin, args, cwd, timeoutMs, signal, children, spawnImpl = spawn, label }) {
  if (signal?.aborted) return { exitCode: -1, stdout: '', stderr: '', error: 'cancelled by the caller' }
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(bin, args, {
        cwd: cwd ?? homedir(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ exitCode: -1, stdout: '', stderr: String(error), error: String(error) })
      return
    }
    children?.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let closed = false
    let reason
    let terminationWarning
    let group = process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0
    let timeout
    let grace
    let deadline
    let monitor

    const groupExists = () => {
      if (!group) return false
      try { process.kill(-child.pid, 0); return true } catch (error) {
        if (error?.code === 'ESRCH') return false
        terminationWarning = `could not verify process group: ${String(error?.message ?? error)}`
        group = false
        return false
      }
    }
    const send = (name) => {
      if (group) {
        try { process.kill(-child.pid, name); return } catch (error) {
          if (error?.code !== 'ESRCH') terminationWarning = `could not signal process group: ${String(error?.message ?? error)}`
          else terminationWarning = 'process group unavailable; only the direct child can be signalled'
          group = false
        }
      }
      try { child.kill(name) } catch (error) {
        terminationWarning = `could not signal child: ${String(error?.message ?? error)}`
      }
    }
    const finish = (result, keepTracking = false) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(grace)
      clearTimeout(deadline)
      if (keepTracking) monitor?.unref?.()
      else clearInterval(monitor)
      signal?.removeEventListener('abort', abort)
      if (!keepTracking) children?.delete(child)
      resolve({ ...result, ...(terminationWarning === undefined ? {} : { terminationWarning }) })
    }
    const maybeFinished = () => {
      if (!closed || groupExists()) return
      if (settled) {
        clearInterval(monitor)
        children?.delete(child)
        return
      }
      finish({ exitCode: -1, stdout, stderr, error: reason })
    }
    const stop = (message) => {
      if (reason !== undefined || settled) return
      reason = message
      if (process.platform === 'win32') terminationWarning = 'process-tree termination is not guaranteed on Windows'
      // Set the timers before signalling: test doubles may emit close synchronously.
      grace = setTimeout(() => { send('SIGKILL'); maybeFinished() }, 5000)
      deadline = setTimeout(() => {
        terminationWarning = `${terminationWarning === undefined ? '' : `${terminationWarning}; `}process termination could not be confirmed`
        finish({ exitCode: -1, stdout, stderr, error: reason }, true)
      }, 10000)
      monitor = setInterval(maybeFinished, 100)
      send('SIGTERM')
      maybeFinished()
    }
    const abort = () => stop('cancelled by the caller')
    // The plugin disposer can also terminate the entire group.
    child.bridgeTerminate = () => {
      if (settled && reason !== undefined) send('SIGKILL')
      else stop('plugin stopped')
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (child.pid === undefined) finish({ exitCode: -1, stdout, stderr, error: error.message })
      else stop(error.message)
    })
    child.on('close', (code) => {
      closed = true
      if (reason === undefined) finish({ exitCode: code ?? -1, stdout, stderr })
      else maybeFinished()
    })
    const effectiveTimeout = Math.max(1000, timeoutMs ?? 300000)
    timeout = setTimeout(() => stop(`${label} timed out after ${effectiveTimeout} ms`), effectiveTimeout)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
