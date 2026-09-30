'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Acceso del personal: sesión, segundo factor, invitaciones y contraseña.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const login = {

  '/api/v1/auth/login/mfa': {
    post: {
      tags: ['Auth'],
      summary: 'Complete a login with a second factor',
      operationId: 'completeMfaLogin',
      description: [
        'Spends the challenge from `/auth/login` together with a code, and returns the session that',
        'the password alone did not.',
        '',
        'The `code` field takes **either** a six-digit TOTP code or a recovery code, and the response',
        'does not say which was used. Both complete the login; distinguishing them would tell somebody',
        'holding a stolen password which secret they were guessing against.',
        '',
        'Every failure is 401 `INVALID_CREDENTIALS` — an expired challenge, a wrong code, a spent',
        'recovery code, an account deactivated in the meantime. Throttled per account, and asking',
        '`/auth/login` for a fresh challenge does not reset that budget.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaChallengeRequest') } } },
      responses: {
        200: { description: 'Session issued.', content: { 'application/json': { schema: ref('Session') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/auth/mfa': {
    get: {
      tags: ['Auth'],
      summary: 'Whether the caller has a second factor',
      operationId: 'getMfaStatus',
      security: staff,
      description:
        'The caller\'s own account only. Nothing here reads, enrols or removes another user\'s factor, including for an OWNER: a manager who could strip a colleague\'s second factor could take over their account.',
      responses: {
        200: { description: 'Second-factor status.', content: { 'application/json': { schema: ref('MfaStatus') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/auth/mfa/enrol': {
    post: {
      tags: ['Auth'],
      summary: 'Begin enrolling a second factor',
      operationId: 'beginMfaEnrolment',
      security: staff,
      description: [
        'Mints a TOTP secret and returns it with an `otpauth://` URI for a QR code. **Nothing is',
        'enabled yet:** the account still signs in on its password alone until a code is confirmed,',
        'which is what makes a failed scan a retry rather than a lockout.',
        '',
        'Calling it again before confirming replaces the secret. 409 `MFA_ALREADY_ENABLED` once a',
        'factor is live — disable it first, which costs a code.',
        '',
        '503 `MFA_KEY_MISSING` when the deployment has no `MFA_SECRET_KEYS` ring configured.'
      ].join('\n'),
      responses: {
        201: { description: 'Secret minted.', content: { 'application/json': { schema: ref('MfaEnrolment') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/confirm': {
    post: {
      tags: ['Auth'],
      summary: 'Turn on the second factor with a code',
      operationId: 'confirmMfaEnrolment',
      security: staff,
      description: [
        'Proves the authenticator holds the secret, and only then does the factor become live.',
        '',
        'Returns the recovery codes, which are **the only time they are readable** — they are stored',
        'hashed. They are not optional: this system has no admin surface, so an owner who loses their',
        'phone with no code is locked out of their own business with nobody able to let them back in.'
      ].join('\n'),
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'Enabled, with recovery codes.', content: { 'application/json': { schema: ref('MfaRecoveryCodes') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/disable': {
    post: {
      tags: ['Auth'],
      summary: 'Remove the second factor',
      operationId: 'disableMfa',
      security: staff,
      description:
        'Costs a code, TOTP or recovery. A live session is deliberately not enough: a borrowed unlocked laptop would otherwise be able to strip the factor and leave the account on a password its borrower may already have.',
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'Disabled.', content: { 'application/json': { schema: { type: 'object', properties: { disabled: { type: 'boolean' } } } } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/recovery-codes': {
    post: {
      tags: ['Auth'],
      summary: 'Replace the recovery codes',
      operationId: 'regenerateMfaRecoveryCodes',
      security: staff,
      description:
        'A fresh sheet for somebody who has spent theirs. Costs a code, and invalidates every code issued before it — including any still unspent on a sheet somebody else may be holding.',
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'New codes.', content: { 'application/json': { schema: ref('MfaRecoveryCodes') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Exchange credentials for a session',
      description: [
        'Rate limited to 10/minute per IP, and fails closed in production: if Redis is unavailable this',
        'returns 503 rather than waving brute-force attempts through. Unknown and known emails take the',
        'same time.',
        '',
        'When the account has a second factor, a correct password does **not** return a session. It',
        'returns `{ mfaRequired: true, challenge }`, and the challenge is spent at',
        '`POST /api/v1/auth/login/mfa`. Branch on `mfaRequired`, not on the absence of a token.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('LoginRequest') } } },
      responses: {
        200: {
          description: 'A session, or an MFA challenge when the account has a second factor.',
          content: { 'application/json': { schema: { oneOf: [ref('Session'), ref('MfaChallenge')] } } }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/auth/invitations/preview': {
    post: {
      tags: ['Auth'],
      summary: 'What an invitation link is for, before accepting it',
      operationId: 'previewStaffInvitation',
      description: [
        'Unauthenticated — whoever opens the link has no account yet — and rate limited with the rest',
        'of /auth by address. The token travels in the body, never in the path: a path ends up in access',
        'logs, and this token is a key.',
        '',
        'Expired, used, revoked and invented tokens all answer `INVITATION_INVALID`, so a caller trying',
        'tokens learns nothing about which it hit.'
      ].join('\n'),
      security: [],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: 'From the fragment of the invitation link.' } } } } }
      },
      responses: {
        200: {
          description: 'The restaurant, the address and the role.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
                  restaurantName: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
        },
        400: response('BadRequest'),
        404: response('NotFound'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/auth/invitations/accept': {
    post: {
      tags: ['Auth'],
      summary: 'Accept an invitation: set your own password and sign in',
      operationId: 'acceptStaffInvitation',
      description: [
        'Creates the account with the password the invited person chooses — nobody else ever knows it —',
        'and returns a session exactly like `POST /api/v1/auth/login`. Single use: the invitation is',
        'locked while it is accepted, so two clicks on the same link cannot create two accounts.',
        '',
        'An address that already has a Splite account answers `INVITATION_EMAIL_IN_USE` and creates',
        'nothing: an email identifies one person across the whole system, not one per restaurant.'
      ].join('\n'),
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'password'],
              properties: {
                token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: 'From the fragment of the invitation link.' },
                password: { type: 'string', minLength: 12, maxLength: 128 },
                displayName: { type: ['string', 'null'], maxLength: 80 }
              }
            }
          }
        }
      },
      responses: {
        201: { description: 'The new session.', content: { 'application/json': { schema: ref('Session') } } },
        400: response('BadRequest'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/auth/password': {
    post: {
      tags: ['Auth'],
      summary: 'Change your own password',
      operationId: 'changePassword',
      description: [
        'Any authenticated staff role, for their own account only — there is no user id in the path,',
        'because the only account you may change here is the one you are signed in as. An',
        'administrator changing somebody else\'s uses `POST /api/v1/account/users/{userId}/password`.',
        '',
        'The current password is required, and that is the guard: an access token in somebody else\'s',
        'hands should not be enough to take an account permanently. It is deliberately **not** counted',
        'against the login throttle — that throttle locks an account, so wiring this into it would let',
        'anyone holding a stolen token lock the real owner out, turning a containable compromise into',
        'a denial of service against the person best placed to fix it. The auth rate limit bounds it.',
        '',
        '**Answers like a login**, because that is what you now hold: every refresh session is revoked',
        'and these are the replacements, so the device doing the changing stays signed in and every',
        'other one is signed out. `sessionsRevoked` counts them.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['currentPassword', 'newPassword'],
              properties: {
                currentPassword: {
                  type: 'string', minLength: 1, maxLength: 128,
                  description: 'Bounded only at the top: it was set under whatever rule was in force when it was chosen, and refusing to read a short legacy password would leave its owner unable to replace it.'
                },
                newPassword: { type: 'string', minLength: 12, maxLength: 128 }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Changed, with a fresh session.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('Session'),
                  {
                    type: 'object',
                    properties: {
                      sessionsRevoked: { type: 'integer', description: 'Other devices signed out.' }
                    }
                  }
                ]
              }
            }
          }
        },
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'The current user',
      operationId: 'getCurrentUser',
      description: [
        'What a client calls when restoring a session on boot. Any authenticated staff role.',
        '',
        '**Use this rather than /auth/refresh to identify the caller.** Refresh *rotates*: two tabs',
        'starting at once both present the same stored token, one claims it, and the other is',
        'treated as theft and revokes every session for that user. Calling refresh merely to ask',
        '"who am I" turns a second browser tab into a logout.',
        '',
        'Read from the database rather than the token, so a deactivated account stops working',
        'inside the access token\'s fifteen minutes rather than at the end of them.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'The caller. Identical in shape to `user` in a login or refresh response.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { user: ref('SessionUser') }
              }
            }
          }
        },
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    },

    patch: {
      tags: ['Auth'],
      summary: 'Set your own display name',
      operationId: 'setOwnDisplayName',
      description: [
        'Anyone signed in, on their own account only. The user id comes from the token, so there',
        'is no id to send and no way to rename somebody else from here -- renaming other staff is',
        '/staff, with its own permissions.',
        '',
        'The empty string clears the name. That is the gesture people expect from emptying the',
        'field, and the alternative would be a separate action meaning "remove my name".',
        '',
        'Changes nothing else: not the role, not the email, and not the sessions. Being called',
        'something different is not a reason to sign anybody out.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('DisplayNameRequest') } } },
      responses: {
        200: {
          description: 'The caller, in the same shape as GET, so a client refreshes what it already stored.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { user: ref('SessionUser') } }
            }
          }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Rotate a refresh token',
      description:
        'Rotation is atomic. Presenting an already-revoked token is treated as theft and revokes every session for that user.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('RefreshRequest') } } },
      responses: {
        200: { description: 'New session issued.', content: { 'application/json': { schema: ref('Session') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke a refresh session',
      description: 'Always 204, so it never reveals whether the token was valid.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('RefreshRequest') } } },
      responses: {
        204: { description: 'Revoked, or the token was already invalid.' },
        400: response('BadRequest'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },
};

module.exports = { login };
