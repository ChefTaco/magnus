import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSwallowedReasons, run } from './check-swallowed-reasons.mjs';

const hits = (text) => findSwallowedReasons('fixture.ts', text).length;

test('flags a bare catch that replies with an HTTP error', () => {
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch { return c.json({ error: 'x' }, 409); } });`), 1);
  assert.equal(hits(`async function f() { try { await x(); } catch { throw new HttpError(409, 'A', 'b'); } }`), 1);
  assert.equal(hits(`async function f() { try { await x(); } catch { return new Response('x', { status: 500 }); } }`), 1);
});

test('allows a bound error, a marker with a reason, and catches that do not reply', () => {
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch (error) { logger.warn(String(error)); return c.json({}, 409); } });`), 0);
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch {\n // no-reason-needed: parse failure is the reason\n return c.json({}, 400); } });`), 0);
  assert.equal(hits(`function f() { try { x(); } catch { /* no reply */ return null; } }`), 0);
  assert.equal(hits(`function f() { try { x(); } catch { return { ok: false }; } }`), 0);
});

test('flags the shape of the original bug: a bound error nobody looks at', () => {
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch (e) { return c.json({ error: { code: 'MANAGED_MUTATION_UNCERTAIN' } }, 409); } });`), 1);
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch (error) { if (error instanceof Foo) return c.json({}, 409); throw new HttpError(500, 'A', 'b'); } });`), 1);
});

test('flags a promise catch that replies without a reason', () => {
  assert.equal(hits(`app.get('/', async c => { return run().catch(() => c.json({}, 500)); });`), 1);
  assert.equal(hits(`app.get('/', async c => { return run().catch(function () { return c.json({}, 500); }); });`), 1);
  assert.equal(hits(`app.get('/', async c => { return run().catch(e => c.json({}, 500)); });`), 1);
});

test('allows a promise catch that logs or carries the cause, and those that do not reply', () => {
  assert.equal(hits(`app.get('/', async c => { return run().catch(e => { logger.warn(String(e)); return c.json({}, 500); }); });`), 0);
  assert.equal(hits(`app.get('/', async c => { return run().catch(e => c.json({ message: String(e) }, 500)); });`), 0);
  assert.equal(hits(`const body = await c.req.json().catch(() => null);`), 0);
  assert.equal(hits(`app.get('/', async c => { return run().catch(() => {\n // no-reason-needed: the status is the reason\n return c.json({}, 404); }); });`), 0);
});

test('allows a reply that carries the cause in it', () => {
  assert.equal(hits(`async function f() { try { await x(); } catch (error) { throw new HttpError(502, 'A', String(error)); } }`), 0);
  assert.equal(hits(`async function f() { try { await x(); } catch (error) { warnCause('x', error); return c.json({}, 500); } }`), 0);
});

test('second review: every shape that used to get through', () => {
  const samples = {
    'error.code looked at, cause dropped': `app.post('/', async c => { try { await x(); } catch (error) { if (error instanceof CommandAdmissionError && error.code !== 'OUTCOME_UNKNOWN') return c.json({error:{code:error.code}},409); return c.json({error:{code:'MANAGED_MUTATION_UNCERTAIN'}},409); } });`,
    'name only in a condition': `app.post('/', async c => { try { await x(); } catch (error) { if (isTimeout(error)) return c.json({},504); return c.json({error:{code:'U'}},409); } });`,
    'log without the error': `app.post('/', async c => { try { await x(); } catch { logger.warn('failed'); return c.json({error:{code:'U'}},409); } });`,
    'log without the bound error': `app.post('/', async c => { try { await x(); } catch (e) { logger.warn('failed'); return c.json({error:{code:'U'}},409); } });`,
    'helper reply': `app.post('/', async c => { const refuse = () => c.json({},409); try { await x(); } catch { return refuse(); } });`,
    'throw typed non-http error': `async function f() { try { await x(); } catch { throw new CommandAdmissionError('LEDGER_UNAVAILABLE','x'); } }`,
    'throw NotDispatchedError': `async function f() { try { await x(); } catch { throw new NotDispatchedError('A','x'); } }`,
    'then rejection handler': `app.post('/', async c => run().then(ok, () => c.json({},500)));`,
    'handler by reference': `const h = () => c.json({},500); app.post('/', async c => run().catch(h));`,
    'function handler by reference': `function h(e) { return c.json({},500); } app.post('/', async c => run().then(ok, h));`,
    'nested catch logs, outer hides': `app.post('/', async c => { try { await x(); } catch { try { await y(); } catch (e) { logger.warn(String(e)); } return c.json({},409); } });`,
    'destructured': `app.post('/', async c => { try { await x(); } catch ({ message }) { return c.json({},409); } });`,
    'name in a string only': `app.post('/', async c => { try { await x(); } catch (error) { return c.json({ error: 'error' },409); } });`,
    'name in a comment only': `app.post('/', async c => { try { await x(); } catch (error) { /* error */ return c.json({},409); } });`,
  };
  for (const [name, text] of Object.entries(samples)) assert.equal(hits(text), 1, name);
});

test('second review: what must stay allowed', () => {
  const samples = {
    'logged by reference handler': `const h = e => { logger.warn(String(e)); return c.json({},500); }; run().catch(h);`,
    'then handler that logs': `run().then(ok, e => { logger.warn(String(e)); return c.json({},500); });`,
    'then with one argument': `run().then(ok);`,
    'an imported handler is out of reach': `run().catch(imported);`,
    'template carries it': "async function f() { try { await x(); } catch (error) { logger.warn(`failed: ${error}`); throw new CommandAdmissionError('A','x'); } }",
    'every reply carries it': `app.post('/', async c => { try { await x(); } catch (error) { if (a) return c.json({ m: String(error) },409); return c.json({ m: error.message },500); } });`,
  };
  for (const [name, text] of Object.entries(samples)) assert.equal(hits(text), 0, name);
});

test('a marker needs a reason', () => {
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch {\n // no-reason-needed:\n return c.json({}, 400); } });`), 1);
});

test('the scoped files have none', () => {
  assert.deepEqual(run(), []);
});
