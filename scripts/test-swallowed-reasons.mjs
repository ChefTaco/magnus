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
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch (error) { log(error); return c.json({}, 409); } });`), 0);
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

test('a marker needs a reason', () => {
  assert.equal(hits(`app.get('/', async c => { try { await x(); } catch {\n // no-reason-needed:\n return c.json({}, 400); } });`), 1);
});

test('the scoped files have none', () => {
  assert.deepEqual(run(), []);
});
