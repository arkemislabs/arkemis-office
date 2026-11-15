// Loopback JSON-RPC transport for the end-to-end test harness ONLY (tests/e2e/harness.mjs, tests/bridge/helpers.mjs).
//
// main.cjs starts it only in test mode: a development checkout (never a packaged build) run with ARKEMIS_STUDIO_TEST=1.
// It serves POST /v2/rpc (one request {id, method, params} or a batch) and GET /v2/events (Server-Sent Events) on
// 127.0.0.1, authenticated with a random bearer token, and records {port, token, pid} in <test data folder>/test-rpc.json
// for the harness. Every request goes to the in-process rpc router (electron/rpc-router.cjs), which drives the editors
// the same way their own controls do. A normal run of the app opens no port.

const http = require('node:http');
const crypto = require('node:crypto');

const BODY_LIMIT = 16 * 1024 * 1024;
const RPC_BATCH_LIMIT = 100;
const SSE_LIMIT = 32;
const SSE_REPLAY = 256;
const HEARTBEAT_MS = 15_000;
const STATUS = {invalid_params: 400, invalid_address: 400, not_found: 404, conflict: 409, disabled: 422, unavailable: 503,
  approval_required: 428, approval_invalid: 403, failed: 500, too_large: 413, timeout: 504};
const EVENT_TYPES = new Set(['doc.changed', 'doc.saved', 'selection.changed', 'document.opened', 'document.closed', 'dialog.opened', 'dialog.closed']);

class BodyTooLarge extends Error {}

async function readBody(req, limit = BODY_LIMIT) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function serializeError(e) {
  const code = typeof e?.code === 'string' && Object.hasOwn(STATUS, e.code) ? e.code : 'failed';
  const out = {code, message: (e && typeof e.message === 'string' && e.message) || 'The request failed'};
  if (e?.data !== undefined) out.data = e.data;
  return out;
}

/** The /v2 routes over the rpc router. */
function createRoutes(router) {
  const streams = new Set();
  const replay = [];
  let eventSeq = 0;

  const unsubscribe = router.subscribe(event => {
    if (!event || !EVENT_TYPES.has(event.type)) return;
    const entry = {seq: ++eventSeq, event};
    replay.push(entry);
    if (replay.length > SSE_REPLAY) replay.shift();
    for (const s of streams) s.push(entry);
  });

  const json = (res, status, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers});
    res.end(body);
  };

  async function runOne(message) {
    const id = message && typeof message === 'object' && !Array.isArray(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return {id, ok: false, error: {code: 'invalid_params', message: 'A request is an object {id, method, params}'}};
    }
    if (typeof message.method !== 'string' || !message.method) return {id, ok: false, error: {code: 'invalid_params', message: 'method is required', data: {path: '/method'}}};
    if (message.params !== undefined && (message.params === null || typeof message.params !== 'object' || Array.isArray(message.params))) {
      return {id, ok: false, error: {code: 'invalid_params', message: 'params must be an object', data: {path: '/params'}}};
    }
    try {
      const result = await router.call(message.method, message.params ?? {});
      return {id, ok: true, result: result === undefined ? null : result};
    } catch (e) {
      return {id, ok: false, error: serializeError(e)};
    }
  }

  function sendReply(res, reply, batch) {
    let body = JSON.stringify(reply);
    if (Buffer.byteLength(body) > BODY_LIMIT) {
      const shrink = r => (r.ok ? {id: r.id, ok: false, error: {code: 'too_large', message: 'The result is larger than 16 MB: ask for less (a narrower address, a smaller limit)'}} : r);
      reply = batch ? reply.map(shrink) : shrink(reply);
      body = JSON.stringify(reply);
    }
    const status = batch || reply.ok ? 200 : STATUS[reply.error.code] ?? 500;
    res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(body);
  }

  async function handleRpc(req, res) {
    if (req.method !== 'POST') return json(res, 405, {id: null, ok: false, error: {code: 'not_found', message: 'Use POST'}}, {Allow: 'POST'});
    let text;
    try { text = await readBody(req); } catch (e) {
      if (e instanceof BodyTooLarge) return json(res, 413, {id: null, ok: false, error: {code: 'too_large', message: 'Request exceeds 16 MB'}}, {Connection: 'close'});
      throw e;
    }
    let message;
    try { message = JSON.parse(text); } catch {
      return json(res, 400, {id: null, ok: false, error: {code: 'invalid_params', message: 'The body is not JSON'}});
    }
    if (Array.isArray(message)) {
      if (!message.length) return json(res, 400, {id: null, ok: false, error: {code: 'invalid_params', message: 'An empty batch'}});
      if (message.length > RPC_BATCH_LIMIT) return json(res, 413, {id: null, ok: false, error: {code: 'too_large', message: `A batch has at most ${RPC_BATCH_LIMIT} requests`}});
      const replies = [];
      for (const m of message) replies.push(await runOne(m));   // in order: later requests may depend on earlier edits
      return sendReply(res, replies, true);
    }
    return sendReply(res, await runOne(message), false);
  }

  function handleEvents(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, {error: 'Use GET'}, {Allow: 'GET'});
    if (streams.size >= SSE_LIMIT) return json(res, 503, {error: 'Too many event subscribers'});
    const doc = url.searchParams.get('doc');
    const types = url.searchParams.get('types');
    const wanted = types ? new Set(types.split(',').map(t => t.trim()).filter(Boolean)) : null;
    if (doc !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(doc)) return json(res, 400, {error: 'Invalid doc'});
    if (wanted && [...wanted].some(t => !EVENT_TYPES.has(t))) return json(res, 400, {error: 'Unknown event type'});
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
    res.flushHeaders?.();
    req.socket.setTimeout?.(0);
    req.socket.setNoDelay?.(true);
    const write = entry => {
      if (doc && entry.event.doc !== doc) return;
      if (wanted && !wanted.has(entry.event.type)) return;
      res.write(`id: ${entry.seq}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    };
    const stream = {push: write};
    res.write('retry: 2000\n: connected\n\n');
    const last = Number(req.headers['last-event-id']);
    if (Number.isSafeInteger(last)) for (const entry of replay) if (entry.seq > last) write(entry);
    streams.add(stream);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    const end = () => { clearInterval(heartbeat); streams.delete(stream); };
    stream.end = () => { end(); res.end(); };
    req.on('close', end);
    res.on('close', end);
    return undefined;
  }

  return {
    async handle(req, res, url) {
      if (url.pathname === '/v2/rpc') { await handleRpc(req, res); return true; }
      if (url.pathname === '/v2/events') { handleEvents(req, res, url); return true; }
      return false;
    },
    close() {
      unsubscribe?.();
      for (const s of [...streams]) s.end?.();
    },
  };
}

/**
 * Start the test transport on an ephemeral loopback port.
 * @param {{router: {call(method: string, params: object): Promise<any>, subscribe(fn: Function): Function}}} opts
 * @returns {Promise<{port: number, token: string, stop(): Promise<void>}>}
 */
async function startTestRpcServer({router} = {}) {
  if (!router || typeof router.call !== 'function') throw new TypeError('startTestRpcServer needs the rpc router');
  const token = crypto.randomBytes(32).toString('hex');
  const routes = createRoutes(router);
  let port;
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
    if (req.headers.origin) return send(403, {error: 'Browser origins are not permitted'});
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(403, {error: 'Invalid host'});
    const auth = req.headers.authorization ?? '', expected = 'Bearer ' + token;
    if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return send(401, {error: 'Unauthorized'});
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await routes.handle(req, res, url)) return;
      return send(404, {error: 'Not found'});
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      send(400, {error: error?.message ?? String(error)});
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
  return {port, token, stop: () => new Promise(resolve => { routes.close(); server.closeAllConnections(); server.close(resolve); })};
}

module.exports = {startTestRpcServer, BODY_LIMIT};
