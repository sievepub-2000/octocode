import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const evidence = 'E:/Program Files/octocode/test/native-recovery'
await fs.mkdir(evidence, { recursive: true })
const fixture = await fs.mkdtemp(path.join(evidence, 'prestream-owned-'))
const binaries = process.env.OCTOCODE_TEST_BINARIES || 'D:/gpt-workspace/octocode/source/octocode-core/src/bin/win32-x64'
const identities = []
for (const name of ['octocode-host.exe', 'octocode-harness.exe']) {
  const source = name === 'octocode-harness.exe' && process.argv[2] ? process.argv[2] : path.join(binaries, name)
  const bytes = await fs.readFile(source)
  await fs.writeFile(path.join(fixture, name), bytes)
  identities.push({ name, source, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
let requests = 0
let titleRequests = 0
const requestShapes = []
let failingTurn = true
const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (!request.url.endsWith('/chat/completions')) {
    response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); return
  }
  const body = JSON.parse(Buffer.concat(chunks).toString())
  // Session titles are independent side calls, not retries of the foreground turn.
  if (body.tool_choice?.function?.name === 'session_title') {
    titleRequests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ id: 'owned-title', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-title-tool', type: 'function', function: { name: 'session_title', arguments: JSON.stringify({ session_title: 'Owned recovery fixture' }) } }] }, finish_reason: null }] }) + '\n\n')
    response.write('data: ' + JSON.stringify({ id: 'owned-title', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n')
    response.end('data: [DONE]\n\n')
    return
  }
  requests++
  requestShapes.push({ stream: body.stream, messageRoles: body.messages?.map(m => m.role), options: Object.keys(body).sort() })
  if (failingTurn) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Owned fixture maximum context length cannot be prefetched with available memory', type: 'invalid_request_error', code: 'prefill_memory_exceeded' } }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (delta, finish_reason = null) => ({ id: 'owned-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'owned-fixture', choices: [{ index: 0, delta, finish_reason }] })
  response.write('data: ' + JSON.stringify(part({ role: 'assistant', content: 'RECOVERED_OWNED_FIXTURE' })) + '\n\n')
  response.write('data: ' + JSON.stringify(part({}, 'stop')) + '\n\n')
  response.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`
const database = path.join(fixture, 'owned.sqlite')
const events = [], pending = new Map(), completions = new Map()
let processHost, serial = 0, sessionId, stderr = ''
function start() {
  processHost = spawn(path.join(fixture, 'octocode-host.exe'), ['--db', database], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  processHost.stderr.on('data', chunk => { stderr += chunk.toString() })
  readline.createInterface({ input: processHost.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.id !== undefined) {
      const callbacks = pending.get(message.id)
      if (!callbacks) return
      pending.delete(message.id)
      if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)))
      else callbacks.resolve(message.result)
    } else {
      events.push(message)
      if (['agent.finished', 'agent.error'].includes(message.kind)) completions.get(message.task_id)?.(message)
    }
  })
}
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, reject })
    processHost.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
async function stop() {
  const ended = new Promise((resolve, reject) => processHost.once('exit', code => code === 0 ? resolve() : reject(new Error(`host exit ${code}`))))
  processHost.stdin.end()
  await ended
}
async function run(prepared, resume, prompt) {
  const completed = new Promise(resolve => completions.set(prepared.task_id, resolve))
  await call('agent.run', { task_id: prepared.task_id, session_id: prepared.session_id, cwd: prepared.working_directory,
    executable: path.join(fixture, 'octocode-harness.exe'), harness_home: path.join(fixture, 'harness'), prompt, resume,
    max_turns: 1, codebase_indexing: false,
    model: { model: 'owned-fixture', base_url: base, api_key: 'owned-local-fixture-placeholder', api_backend: 'chat_completions', context_window: 65536, max_completion_tokens: 1000 },
    supervision: { stream_rules: [], max_interventions: 0, fallbacks: [] } })
  return completed
}
const provider = { apiProvider: 'openai-native', apiModelId: 'owned-fixture', openAiNativeBaseUrl: base }
const deadline = setTimeout(() => { processHost?.kill(); throw new Error('owned pre-stream recovery probe exceeded 60 seconds') }, 60_000)
try {
  start()
  const first = await call('harness.prepare', { title: 'owned recovery fixture', prompt: 'Owned first fixture turn.', workspace: fixture, provider })
  sessionId = first.session_id
  const failed = await run(first, false, 'Owned first fixture turn.')
  assert.equal(failed.kind, 'agent.finished')
  assert.equal(failed.payload.success, false)
  const afterFailure = await call('session.get', { id: sessionId })
  assert.equal(afterFailure.status, 'failed')
  const memoryError = events.find(event => event.task_id === first.task_id && event.kind === 'error')
  assert.equal(memoryError?.payload.error_code, 'prefill_memory_exceeded')
  assert.equal(memoryError?.payload.http_status, 400)
  assert.equal(memoryError?.payload.recoverable, true)
  if (requests < 1) console.log(JSON.stringify({ diagnostic: 'provider not reached', terminal: failed, events }))
  assert(requests >= 1, 'the failed turn must actually reach the controlled provider')
  const failedTurnRequests = requests
  assert.equal(titleRequests, 1, 'the independent initial title request must be recognized explicitly')
  if (failedTurnRequests !== 1) console.log(JSON.stringify({ requestShapes }))
  assert.equal(failedTurnRequests, 1, 'prefill memory pressure must not trigger retries or automatic compaction')
  failingTurn = false
  const continued = await call('harness.continue', { session_id: sessionId, prompt: 'Owned second fixture turn.', provider })
  const recovered = await run(continued, true, 'Owned second fixture turn.')
  assert.equal(recovered.kind, 'agent.finished')
  assert.equal(recovered.payload.success, true)
  assert(events.some(event => event.task_id === continued.task_id && event.kind === 'text' && JSON.stringify(event.payload).includes('RECOVERED_OWNED_FIXTURE')))
  const afterRecovery = await call('session.get', { id: sessionId })
  assert.notEqual(afterRecovery.status, 'running')
  const history = await call('event.page', { session_id: sessionId, limit: 2000 })
  assert(history.rows.some(row => row[1] === 'agent.finished' && row[2].success === false))
  assert(history.rows.some(row => row[1] === 'agent.finished' && row[2].success === true))
  assert(history.rows.some(row => row[1] === 'error' && row[2].error_code === 'prefill_memory_exceeded' && row[2].recoverable === true))
  await stop()
  start()
  const reopened = await call('session.get', { id: sessionId })
  assert.equal(reopened.status, afterRecovery.status)
  console.log(JSON.stringify({ status: 'PASS', fixture, identities, requests, titleRequests, failedTurnRequests, failureTerminal: failed.payload, failureStatus: afterFailure.status, recoveryTerminal: recovered.payload, recoveryStatus: afterRecovery.status, restartStatus: reopened.status, actualProviderHTTP: true, userDataUsed: false, runtimeTsRunningSessionsScope: 'reviewed separately; this probe executes native Host and harness only' }))
} finally {
  clearTimeout(deadline)
  if (processHost?.exitCode === null) {
    try {
      if (sessionId) {
        assert.equal((await call('session.delete', { id: sessionId })).deleted, true)
        assert.equal(await call('session.get', { id: sessionId }), null)
      }
    } finally { await stop() }
  }
  await new Promise(resolve => server.close(resolve))
  await fs.writeFile(path.join(fixture, 'host-stderr.log'), stderr)
  await fs.writeFile(path.join(fixture, 'events.json'), JSON.stringify(events, null, 2) + '\n')
}
