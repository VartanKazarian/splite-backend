const { test } = require('node:test');
const assert = require('node:assert/strict');

const { byteCappedCollector, readCappedText, MAX_BODY_BYTES } = require('../src/connectors/resilient');

/**
 * Reading from a host we do not run.
 *
 * A timeout stops an upstream that has gone quiet. It does nothing about one
 * that keeps talking, and reading a response into memory with no ceiling is how
 * a broken or hostile host takes the process down with a body.
 */

test('the ceiling is counted in bytes, not characters', () => {
  // The distinction is not academic here: the page this reads is in Spanish,
  // and every accented character is two bytes and one character. Counting
  // String.length would let a body through at roughly twice the ceiling.
  const collector = byteCappedCollector(10);
  collector.push('ñññññ');           // five characters, ten bytes
  assert.equal(collector.bytes, 10);
  assert.throws(() => collector.push('!'), /exceeded 10 bytes/);
});

test('a character split across two chunks still decodes', () => {
  // Chunk boundaries land wherever the network put them. Decoding each chunk on
  // arrival would turn a split two-byte character into two replacement
  // characters; decoding once at the end does not.
  const collector = byteCappedCollector(100);
  const whole = Buffer.from('ñ');
  collector.push(whole.subarray(0, 1));
  collector.push(whole.subarray(1));
  assert.equal(collector.text(), 'ñ');
});

test('overflow is fatal, so it is not retried', () => {
  // A body too large once is too large again. Retrying it three times is three
  // times the memory for the same answer.
  const collector = byteCappedCollector(4);
  try {
    collector.push('12345');
    assert.fail('expected a refusal');
  } catch (err) {
    assert.equal(err.fatal, true);
    assert.equal(err.code, 'RESPONSE_TOO_LARGE');
  }
});

test('a body under the ceiling is returned whole', async () => {
  const text = await readCappedText(new Response('a menu of rates'), { maxBytes: 1000 });
  assert.equal(text, 'a menu of rates');
});

test('an oversized body is refused mid-stream', async () => {
  const big = 'x'.repeat(5000);
  await assert.rejects(
    () => readCappedText(new Response(big), { maxBytes: 100 }),
    err => {
      assert.equal(err.code, 'RESPONSE_TOO_LARGE');
      assert.equal(err.fatal, true);
      return true;
    }
  );
});

test('a declared content-length over the ceiling is refused before reading', async () => {
  // Cheaper and clearer than streaming it first, where the server is honest
  // enough to say how big it is.
  const response = new Response('short', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
  await assert.rejects(
    () => readCappedText(response),
    /declared \d+ bytes, over the \d+ ceiling/
  );
});

test('a missing or unparseable content-length does not refuse by itself', async () => {
  // Absence is not a claim about size. The stream cap is what enforces the
  // ceiling; the header is only an early exit when it is there.
  const text = await readCappedText(new Response('fine', { headers: { 'content-length': 'nonsense' } }));
  assert.equal(text, 'fine');
});
