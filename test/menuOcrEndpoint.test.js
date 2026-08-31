const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completionsUrl } = require('../src/services/menuOcr');

/**
 * Which URL a configured provider actually gets called at.
 *
 * This is the whole of the module's claim to be provider-portable, and it is
 * invisible from outside: a base URL resolved wrongly produces a 404, which the
 * caller sees as MENU_OCR_UNAVAILABLE -- the same answer as a provider that is
 * genuinely down. So the mapping is pinned per vendor rather than described.
 */
test('the version path in the base URL survives', () => {
  const cases = [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/chat/completions']
  ];

  for (const [base, expected] of cases) {
    assert.equal(completionsUrl(base), expected, `base ${base}`);
  }
});

test('a trailing slash does not double up', () => {
  assert.equal(
    completionsUrl('https://generativelanguage.googleapis.com/v1beta/openai/'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
  assert.equal(completionsUrl('https://api.openai.com/v1///'), 'https://api.openai.com/v1/chat/completions');
});

test('the path is appended, never resolved against the origin', () => {
  // The regression this exists for. `new URL('/chat/completions', base)` treats
  // the leading slash as absolute and discards the base's path, which sent
  // every vendor but OpenAI to the root of its own origin.
  const url = completionsUrl('https://generativelanguage.googleapis.com/v1beta/openai');

  assert.match(url, /v1beta\/openai\/chat\/completions$/);
  assert.doesNotMatch(url, /googleapis\.com\/chat/);
});
