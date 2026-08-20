'use strict';

const js = require('@eslint/js');
const globals = require('globals');

/**
 * Lint rules, chosen for what they catch rather than for how code looks.
 *
 * `npm run lint` used to be `node --check`, which only parses: a file could
 * reference a variable that does not exist, shadow a payment amount with
 * another one, or leak an assignment into the global object, and still pass.
 * Those are the three the README complained about and they are all correctness
 * bugs, not formatting.
 *
 * There is deliberately no style layer here -- no quote, semicolon, indent or
 * line-length rules. Reformatting a codebase to satisfy a linter buries the
 * commits that change behaviour, and this repository's reviews are about
 * behaviour. If a formatter is ever wanted, it should arrive as its own
 * decision.
 */
module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**']
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      // CommonJS: every file here uses require/module.exports.
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },

    rules: {
      /**
       * An unused variable is usually the remains of an edit that half
       * happened -- the dangerous kind being a value someone computed, stopped
       * using, and left behind looking authoritative.
       *
       * A leading underscore opts out, which is what an Express error handler
       * needs: it is only recognised as one by having four parameters, so the
       * fourth has to exist whether or not it is called.
       */
      'no-unused-vars': ['error', {
        args: 'after-used',
        // `const { phone, ...rest } = body` is how a key is dropped; the named
        // half is meant to go unused.
        ignoreRestSiblings: true,
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],

      /**
       * Shadowing is the one that matters most in this codebase. Money moves
       * through nested scopes here -- `amount` inside a transaction callback
       * inside a handler that already has an `amount` -- and an inner binding
       * that silently masks an outer one is how the wrong figure gets written
       * while every line still reads correctly.
       */
      'no-shadow': 'error',

      // An assignment to an undeclared name is a global, shared by every
      // request the process serves. `no-undef` comes from recommended; this is
      // the write side of the same mistake.
      'no-implicit-globals': 'error',

      // `==` against null is idiomatic here for "null or undefined" and is
      // used deliberately; everything else must say which it means.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // A promise nobody waits on inside a transaction is a write that may
      // land after the commit.
      'require-atomic-updates': 'error',
      'no-return-await': 'error',

      // Reassigning a parameter makes the value at the top of a function stop
      // describing what the caller passed, which is exactly the thing being
      // reasoned about in a payment path.
      'no-param-reassign': 'error',

      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }]
    }
  },

  {
    // The suites talk to real services and deliberately monkey-patch module
    // exports to inject failures; that is the technique, not an accident.
    files: ['test/**/*.js'],
    rules: {
      'no-param-reassign': 'off',
      /**
       * The suites replace `db.withTransaction` or `bcv.fetchRates` with a
       * failing stub, await the call, and restore it. The rule reads that as a
       * value assigned from a stale read across an await -- which is the real
       * hazard it exists for in a concurrent handler, and exactly the intended
       * technique here, in a file that runs one statement at a time. Left on
       * for `src/`, where it means something.
       */
      'require-atomic-updates': 'off'
    }
  }
];
