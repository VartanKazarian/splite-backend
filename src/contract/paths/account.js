'use strict';

const { ref, response, minorUnits, commonErrors, staff } = require('../common');

/**
 * La cuenta del restaurante: datos, plan, bancos, equipo y suscripción.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const users = {

  '/api/v1/account/users': {
    get: {
      tags: ['Account'],
      summary: 'The people who work here',
      operationId: 'listStaff',
      description: [
        'OWNER and MANAGER only.',
        '',
        'Deactivated accounts are listed too, and last. They are the ones somebody needs to find in',
        'order to reinstate, and hiding them makes a reactivation look like a second account with the',
        'same address — which the unique index then refuses, confusingly.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Staff, active first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('StaffMember') } }
              }
            }
          }
        },
        403: response('Forbidden'),
        ...commonErrors
      }
    },

    post: {
      tags: ['Account'],
      summary: 'Add somebody',
      operationId: 'createStaff',
      description: [
        'OWNER and MANAGER only, and a manager may only grant a role below their own — without that',
        'second half, "may manage staff" silently means "may become an owner".',
        '',
        'The password takes the same rule as registration rather than a laxer one: this account signs',
        'in through exactly the same door, so a shorter password here would be a quieter way into the',
        'same building. There is no self-service change yet, so tell the person what you set.',
        '',
        '`role` is required and not defaulted. What this person may do is the whole point of creating',
        'them, and a default would be the answer nobody chose.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password', 'role'],
              properties: {
                email: { type: 'string', format: 'email', maxLength: 254 },
                password: { type: 'string', minLength: 12, maxLength: 128 },
                role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { user: ref('StaffMember') } }
            }
          }
        },
        403: response('Forbidden'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },
};

const subscription = {

  '/api/v1/account/subscription': {
    get: {
      tags: ['Account'], summary: 'What the restaurant pays Splite', operationId: 'getSubscription',
      description: 'OWNER and MANAGER. Plan, price, balance, the last charges (with the amount in Bs at today\'s BCV rate when there is one), where to pay Splite and the restaurant\'s own payment notices. Never Splite\'s internal notes.',
      security: staff, 'x-required-roles': ['OWNER', 'MANAGER'],
      responses: {
        200: { description: 'The subscription.', content: { 'application/json': { schema: { type: 'object', properties: {
          subscription: { type: 'object', properties: {
            tier: { type: 'string' }, state: { type: 'string' }, status: { type: 'string' }, billingCycle: { type: 'string' },
            priceUsd: { ...minorUnits, type: ['string', 'null'] }, trialEndsAt: { type: ['string', 'null'], format: 'date-time' },
            balanceUsd: minorUnits, balanceVesToday: { ...minorUnits, type: ['string', 'null'] }
          } },
          charges: { type: 'array', items: ref('AdminCharge') },
          notices: { type: 'array', items: ref('SubscriptionNotice') },
          paymentDetails: { oneOf: [ref('PaymentDetails'), { type: 'null' }] },
          rate: { type: ['object', 'null'], properties: { rate: { type: 'string' }, valueDate: { type: ['string', 'null'], format: 'date' } } }
        } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/account/subscription/notices': {
    post: {
      tags: ['Account'], summary: 'Tell Splite you paid', operationId: 'submitSubscriptionNotice',
      description: 'OWNER and MANAGER. Stays PENDING until someone at Splite finds it in the bank and confirms it (then it is recorded as a payment) or rejects it with a reason. The same reference cannot be reported twice unless the earlier notice was rejected.',
      security: staff, 'x-required-roles': ['OWNER', 'MANAGER'],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['method', 'currency', 'amount', 'paidOn'], properties: {
        chargeId: { type: ['string', 'null'], format: 'uuid' },
        method: { type: 'string', enum: ['PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER'] },
        currency: { type: 'string', enum: ['VES', 'USD'] },
        amount: minorUnits,
        reference: { type: ['string', 'null'] },
        paidOn: { type: 'string', format: 'date' },
        notes: { type: ['string', 'null'] }
      } } } } },
      responses: {
        201: { description: 'Received.', content: { 'application/json': { schema: { type: 'object', properties: { notice: ref('SubscriptionNotice') } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },
};

const invitations = {

  '/api/v1/account/invitations': {
    get: {
      tags: ['Account'],
      summary: 'Open invitations to the team',
      operationId: 'listStaffInvitations',
      description: 'OWNER and MANAGER only. Open means not accepted, not revoked and not expired.',
      security: staff,
      responses: {
        200: {
          description: 'Open invitations, newest first.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { data: { type: 'array', items: ref('StaffInvitation') } } }
            }
          }
        },
        403: response('Forbidden'),
        ...commonErrors
      }
    },

    post: {
      tags: ['Account'],
      summary: 'Invite somebody to the team',
      operationId: 'createStaffInvitation',
      description: [
        'OWNER and MANAGER only, with the same rank rule as creating staff: a manager may only invite',
        'to a role below their own.',
        '',
        'Returns the link **once**. Only its SHA-256 is stored, so it cannot be shown again; to send it',
        'again, create a new invitation for the same address, which revokes the previous one. The token',
        'rides in the link\'s fragment (`#...`), which browsers never send to a server.',
        '',
        '`emailed` says whether it also went out by email. It is false when mail is not configured',
        '(the development `log` transport would write the link into production logs), and the link is',
        'then shared by the person inviting — typically over WhatsApp. Valid for 7 days.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'role'],
              properties: {
                email: { type: 'string', format: 'email', maxLength: 254 },
                role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  invitation: ref('StaffInvitation'),
                  link: { type: 'string', format: 'uri' },
                  emailed: { type: 'boolean' }
                }
              }
            }
          }
        },
        403: response('Forbidden'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/invitations/{invitationId}': {
    delete: {
      tags: ['Account'],
      summary: 'Revoke an open invitation',
      operationId: 'revokeStaffInvitation',
      description: 'OWNER and MANAGER only, and only for an invitation to a role they could have granted.',
      security: staff,
      parameters: [{ name: 'invitationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        204: { description: 'Revoked.' },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/users/{userId}': {
    patch: {
      tags: ['Account'],
      summary: 'Change a role, a standing, or both',
      operationId: 'updateStaff',
      description: [
        'OWNER and MANAGER only. Three rules apply, and each has its own error code:',
        '',
        '- **Rank.** An owner may act on anybody but themselves; anyone else only on a strictly lower',
        '  role, and may only grant one (`STAFF_OUTRANKED`, `STAFF_ROLE_TOO_HIGH`).',
        '- **Never yourself** (`STAFF_SELF_FORBIDDEN`). It stops an owner demoting themselves out of',
        '  the only account that could undo it, and costs nothing: another owner can still do it.',
        '- **The last active owner stays** (`STAFF_LAST_OWNER`), checked under lock so two requests',
        '  removing the last two owners cannot both see the other and succeed.',
        '',
        '**`sessionsRevoked` is the honest half of the answer.** Deactivating or changing a role kills',
        'every refresh token the person holds, so they cannot mint a new access token. The access',
        'token already in their hands keeps working until it expires — at most `JWT_ACCESS_TTL`,',
        'fifteen minutes by default. Somebody removing a person after an argument needs to know the',
        'door is not shut this second.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              description: 'At least one of the two: a PATCH that changes nothing is a request somebody meant to be a change.',
              properties: {
                role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
                active: { type: 'boolean' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Updated.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user: ref('StaffMember'),
                  sessionsRevoked: { type: 'integer', description: 'Refresh sessions ended by this change.' }
                }
              }
            }
          }
        },
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/users/{userId}/password': {
    post: {
      tags: ['Account'],
      summary: "Set somebody else's password",
      operationId: 'resetStaffPassword',
      description: [
        'OWNER and MANAGER only, subject to the same rank and self rules as a role change.',
        '',
        'This is also how a forgotten password is recovered, because there is no self-service change',
        'yet. It revokes their sessions, which is the point: a reset that leaves the old sessions',
        'running has not locked anybody out.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['password'],
              properties: { password: { type: 'string', minLength: 12, maxLength: 128 } }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Set.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { sessionsRevoked: { type: 'integer' } }
              }
            }
          }
        },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/contacts': {
    get: {
      tags: ['Account'],
      summary: 'Diners who asked to hear from the restaurant',
      operationId: 'listGuestContacts',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Not "everyone who has paid here": only the diners who ticked an empty box saying yes, and',
        'have not withdrawn since. That difference is the whole product — a list of people who',
        'agreed is worth something, and a list of people who merely wanted their invoice is a',
        'problem waiting.',
        '',
        'There is deliberately no parameter for "all the addresses". It would exist to be used, and',
        'the only thing to do with the others is send them something they did not ask for.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }
      ],
      responses: {
        200: {
          description: 'Consented contacts, newest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        email: { type: 'string' },
                        name: { type: ['string', 'null'] },
                        consentAt: { type: ['string', 'null'], format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        ...commonErrors,
        403: response('Forbidden')
      }
    }
  },

  '/api/v1/account/banks': {
    get: {
      tags: ['Account'],
      summary: 'Venezuelan banks a payee can be configured against',
      operationId: 'listBanks',
      description: [
        'Any authenticated staff role.',
        '',
        'Read `chargeable` rather than assuming: a restaurant may name any bank, because that is',
        'where diners send money whether or not we integrate with it, but only a bank with a module',
        'can take part in an in-app payment. Nothing is chargeable today.',
        '',
        '**The list is not officially sourced.** It has been cross-checked against two independent',
        'published lists, which agreed on every code, but the BCV register itself has not been read.',
        'The codes are load-bearing — a wrong one sends money to another institution — so confirming',
        'them against that register is a prerequisite for the first bank module.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Banks, ordered by name.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        name: { type: 'string' },
                        chargeable: { type: 'boolean' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/account/payment-providers': {
    get: {
      tags: ['Account'],
      summary: 'Which bank rails this restaurant has credentials for',
      operationId: 'listPaymentProviders',
      description: [
        'Any authenticated staff role. Returns metadata only — there is no endpoint that returns a',
        'stored credential, and the schema has no field that could carry one.',
        '',
        '`supported` lists the providers this deployment has an adapter for.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Configured providers.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('PaymentProviderConfig') },
                  supported: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/account/payment-providers/{provider}': {
    put: {
      tags: ['Account'],
      summary: 'Store bank API credentials',
      operationId: 'putPaymentProviderCredentials',
      'x-required-roles': ['OWNER'],
      description: [
        '**OWNER only** — not MANAGER, who may set the payee. The payee says where money should be',
        'sent; these let software move it, which is a different kind of authority.',
        '',
        'The body shape is per provider, because no two banks agree on what a credential is.',
        'MERCANTIL takes `merchantId`, `clientId`, `secretKey`, `integratorId` and `terminalId`.',
        'Unknown fields are rejected rather than stored: a blob that carries whatever was sent is',
        'where a stray password ends up, sealed forever and invisible to review.',
        '',
        'Credentials are sealed with AES-256-GCM before they reach the database and are never',
        'returned. Replacing them resets `enabled` to false and clears `credentialsValidatedAt` —',
        'new credentials are unproven credentials, and a mistyped key must not leave a rail',
        'switched on and quietly broken.',
        '',
        'Answers 503 `PAYMENT_CREDENTIALS_KEY_MISSING` when the deployment has no encryption key',
        'configured. That is configuration, not a bug, and the code says so.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' }, example: 'MERCANTIL' }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('PaymentProviderConfig') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        503: response('ServiceUnavailable')
      }
    },

    delete: {
      tags: ['Account'],
      summary: 'Remove bank API credentials',
      operationId: 'deletePaymentProviderCredentials',
      'x-required-roles': ['OWNER'],
      description: 'OWNER only. Removes the row outright; there is nothing to keep once the credentials are gone.',
      security: staff,
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/account/payout': {
    put: {
      tags: ['Account'],
      summary: 'Set or clear where the restaurant is paid',
      operationId: 'setPayout',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. This is the address money is sent to — getting it wrong does not',
        'degrade the product, it pays a stranger — so it is not a change a waiter makes from the',
        'floor.',
        '',
        'Send all four fields, or `{}` to clear. The account number must begin with its own bank',
        'code, which is checked here rather than left to a database CHECK so the error names the',
        'field.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('PayoutRequest') } } },
      responses: {
        200: { description: 'The account, with its payee.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/account': {
    get: {
      tags: ['Account'],
      summary: "The signed-in restaurant's own record and plan",
      operationId: 'getAccount',
      description: [
        'Any authenticated staff role.',
        '',
        'The source of the trial banner. Note what it does **not** do: nothing in the API refuses',
        'service when a trial lapses. Which action a lapsed restaurant loses is a pricing decision,',
        'and the obvious candidate is the wrong one — cutting off bills mid-service strands a dining',
        'room full of seated diners over an unpaid invoice. Until that is decided deliberately, the',
        'dates are reported and the client warns.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The restaurant and its plan.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        404: response('NotFound')
      }
    },
    patch: {
      tags: ['Account'],
      summary: 'Update the restaurant',
      operationId: 'updateAccount',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Partial update; at least one field is required. Omitting a field',
        'leaves it as it is — in particular, changing the invoicing policy does not require',
        'resending the name, which is how a restaurant gets renamed by accident.',
        '',
        '`name` is what a diner reads on their phone the moment they scan the code on the table,',
        'above the table number. It could previously only be set during onboarding, which left',
        'whatever was typed that day in front of every customer with no way to correct it.',
        '',
        '`fiscalInvoicePolicy` is **OWNER only**, and answers with 403 `FORBIDDEN_ROLE` for a',
        'MANAGER. It is not profile editing: it decides how the restaurant declares, so it sits',
        'with the money decisions and is audited separately as `FISCAL_POLICY_CHANGED`.',
        '',
        'Menu currency, charges and the payee each still have their own endpoint, because each is',
        'a different decision with a different reach.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateAccountRequest') } } },
      responses: {
        200: { description: 'The updated restaurant.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/account/rif': {
    put: {
      tags: ['Account'],
      summary: 'Set the RIF this restaurant declares under',
      operationId: 'setFiscalRif',
      'x-required-roles': ['OWNER'],
      description: [
        'Roles: OWNER. Separate from `PATCH /account` for the reason the series is separate: the',
        "restaurant's name is profile data, the RIF is the identity it declares under. A manager",
        'who may rename the place is not thereby allowed to change taxpayer. Audited as',
        '`FISCAL_RIF_CHANGED`, carrying the previous value.',
        '',
        'There is no GET — the RIF already travels in `GET /account`.',
        '',
        '**Shape is enforced; the check digit is not.** A malformed value is refused with 400',
        '`FISCAL_RIF_MALFORMED`. A well-shaped one whose check digit disagrees is *stored*, and the',
        'response says so in `checksumOk`. The asymmetry is deliberate: the check-digit routine has',
        'never been run against a corpus of real RIFs, and refusing on it risks leaving a genuine',
        'restaurant unable to invoice because of a bug of ours — while a wrong RIF prints on every',
        'invoice and is worth shouting about. So it warns rather than blocks.',
        '',
        '**It freezes once a fiscal document has been issued** (409 `FISCAL_RIF_LOCKED`). Changing',
        'it then would not change the issuer going forward, it would contradict documents already',
        'in customers\' hands: the libro de ventas would stop matching the paper. Same rule, and',
        'same reason, as the frozen series fields — and the same remedy, a credit note.',
        '',
        'The RIF is unique across tenants. A collision answers 409 `FISCAL_RIF_TAKEN`, which',
        'usually means that taxpayer already has an account.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('FiscalRifRequest') } } },
      responses: {
        200: { description: 'The stored RIF.', content: { 'application/json': { schema: ref('FiscalRifResponse') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/account/fiscal-series': {
    get: {
      tags: ['Account'],
      summary: 'The authorised invoice series',
      operationId: 'getFiscalSeries',
      description: [
        'Any authenticated staff role — staff may legitimately need to check which number the',
        'restaurant is on.',
        '',
        'Answers `{ "fiscalSeries": null }` when none is configured, rather than 404.',
        '',
        'Only relevant where the deployment issues by its own means. Where an imprenta digital',
        'assigns the numbers, this is not what governs them.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The series, or null.', content: { 'application/json': { schema: ref('FiscalSeriesResponse') } } },
        ...commonErrors
      }
    },
    put: {
      tags: ['Account'],
      summary: 'Set the authorised invoice series',
      operationId: 'setFiscalSeries',
      'x-required-roles': ['OWNER'],
      description: [
        'Roles: OWNER. Not profile editing — it transcribes a SENIAT authorisation and decides how',
        'the restaurant numbers what it declares, so it sits with the money decisions and is',
        'audited separately as `FISCAL_SERIES_CHANGED`.',
        '',
        'A full replacement, not a patch: a series missing a field cannot number anything.',
        '',
        '**Four fields freeze once the series has numbered a document** — `controlPrefix`,',
        '`documentPrefix`, `padTo` and `controlFirst`. Changing them would not change the series',
        'going forward, it would contradict what is already issued: the libro de ventas would hold',
        'two formats, and documents whose numbers no longer match the series that claims them. A',
        'PUT that tries answers 409 `FISCAL_SERIES_LOCKED`, naming the fields in `details.fields`.',
        '',
        'What stays open is exactly what changes in practice: `controlLast` and',
        '`authorisationRef`, for when a new authorisation widens the range. Lowering `controlLast`',
        'below a number already issued is refused for the same reason.',
        '',
        'A prefix typo found after issuing is not fixed here. A wrong document is already printed,',
        'and that is resolved with a credit note — not by rewriting the series so the error stops',
        'showing.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('FiscalSeriesRequest') } } },
      responses: {
        200: { description: 'The stored series.', content: { 'application/json': { schema: ref('FiscalSeriesResponse') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },
};

module.exports = { users, subscription, invitations };
