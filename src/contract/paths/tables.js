'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Mesas del restaurante.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/tables': {
    get: {
      tags: ['Tables'],
      summary: 'List tables',
      description: 'Any authenticated staff role.',
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } }
      ],
      responses: {
        200: { description: 'Tables.', content: { 'application/json': { schema: ref('TableList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Tables'],
      summary: 'Create a table, or bring back the deleted one with that name',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Deleting a table is `PATCH { active: false }` \u2014 there is no DELETE, because a table',
        'carries bills and history. The row therefore keeps its name under UNIQUE (restaurant_id,',
        'name) while disappearing from every screen that filters on `active`, so creating that',
        'name again is a conflict with a table nobody can see.',
        '',
        'It is therefore reactivated instead of refused, and answers **200** with the original',
        'table \u2014 same id, same created_at, same QR. A guest QR lookup requires `active = true`,',
        'so the printed sticker died with the deactivation and comes back with the table; a new',
        'row would leave that sticker dead.',
        '',
        'A name an **active** table is using is still refused with 409 TABLE_NAME_TAKEN.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateTableRequest') } } },
      responses: {
        200: {
          description: 'A deleted table with this name was reactivated. Nothing was created.',
          content: { 'application/json': { schema: ref('Table') } }
        },
        201: { description: 'Created.', content: { 'application/json': { schema: ref('Table') } } },
        ...commonErrors,
        403: response('Forbidden'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/tables/floor': {
    get: {
      tags: ['Tables'],
      summary: 'Every table with the bill open on it',
      operationId: 'getFloor',
      description: [
        'Any authenticated staff role. What an owner dashboard renders.',
        '',
        'One call instead of 1 + N: listing tables and then asking each for its open bill costs',
        'a request per table on every poll. `openBill` is null for a free table rather than absent,',
        'so the shape does not change with occupancy.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The floor.', content: { 'application/json': { schema: ref('FloorList') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/tables/bulk': {
    post: {
      tags: ['Tables'],
      summary: 'Create the tables a restaurant has',
      operationId: 'createTablesInBulk',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Say how many tables the restaurant has and the missing ones are',
        'created as `<prefix> 1` … `<prefix> N`.',
        '',
        'Idempotent, and it never deletes: raising the count later adds only the new tables, and',
        'lowering it removes nothing — a table that already carries bills is not something a',
        'number in a form should be able to destroy.',
        '',
        'A table inside the range that had been deleted (deactivated) comes back, and is reported',
        'under `reactivated`. Asking for ten tables and being handed nine, with nothing saying',
        'which is missing, is the deletion surprising the restaurant a second time. A deactivated',
        'table *outside* the range is left alone.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('BulkTablesRequest') } } },
      responses: {
        201: { description: 'Tables created.', content: { 'application/json': { schema: ref('BulkTablesResult') } } },
        ...commonErrors,
        403: response('Forbidden')
      }
    }
  },

  '/api/v1/tables/{tableId}': {
    patch: {
      tags: ['Tables'],
      summary: 'Update a table',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. Partial update; at least one field is required.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateTableRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('Table') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },
};

module.exports = { core };
