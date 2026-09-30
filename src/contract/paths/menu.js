'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * La carta: productos, secciones, fotos, PDF y lectura desde una foto.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const publicMenu = {

  '/api/v1/menu/public/{restaurantId}/pdf': {
    parameters: [{ $ref: '#/components/parameters/RestaurantId' }],
    get: {
      tags: ['Menu'],
      summary: 'The uploaded menu, to a diner',
      description: [
        'Unauthenticated, like the public product list beside it and for the same reason: a diner',
        'scanning a table QR holds no staff credentials, and what this serves is a file the',
        'restaurant chose to publish.',
        '',
        'Served `inline` so a phone opens it rather than downloading it, with the restaurant\'s own',
        'filename so a diner who does save it gets something readable. `nosniff` is set: a stored',
        'file is served as what it says it is and nothing else.'
      ].join('\n'),
      security: [],
      responses: {
        200: {
          description: 'The file.',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
        },
        404: { description: 'Nothing uploaded, or no such restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        400: { description: 'Malformed restaurant id.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/products': {
    get: {
      tags: ['Menu'],
      summary: 'Public menu for a restaurant',
      description: 'Unauthenticated: a guest scanning a table QR holds no staff credentials.',
      security: [],
      parameters: [{ $ref: '#/components/parameters/RestaurantId' }],
      responses: {
        200: { description: 'Active menu.', content: { 'application/json': { schema: ref('PublicMenu') } } },
        400: response('BadRequest'),
        404: response('NotFound'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/menu/settings': {
    get: {
      tags: ['Menu'],
      summary: 'Restaurant menu settings',
      operationId: 'getMenuSettings',
      description: [
        'Any authenticated staff role.',
        '',
        '**Read `menuOcrAvailable` before offering the photo import.** Reading a menu from a photo is',
        'opt-in per deployment — it costs money per call and reaches a third party — so a server',
        'without a key configured answers `503 MENU_OCR_NOT_CONFIGURED`. Without this flag a client',
        'has no way to know that until after the user has chosen a file and waited for several',
        'megabytes to upload. Asking is free and the answer does not change between requests.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Settings, including charge rates and what this deployment can do.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('MenuCharges'),
                  {
                    type: 'object',
                    properties: {
                      menuOcrAvailable: {
                        type: 'boolean',
                        description: 'Whether this server can read a menu from a photo or PDF. False means hide the import, not retry it: it is a fact about the deployment, not a transient failure.'
                      }
                    }
                  }
                ]
              }
            }
          }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/settings/charges': {
    patch: {
      tags: ['Menu'],
      summary: 'Set the IVA and service charge rates',
      operationId: 'setMenuCharges',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Rates are **basis points**: 1600 is 16%, 1000 is 10%. Send either,',
        'or both.',
        '',
        'Both are snapshotted onto a bill when it opens, so changing them never reprices a meal',
        'already being eaten — and a bill that is already open **keeps the rates it started with**.',
        'The response reports how many open bills are therefore unaffected; close or void one if it',
        'needs the new figures.',
        '',
        'Both default to 0, including for Venezuela\'s statutory 16%: a restaurant is configured',
        'deliberately rather than by a migration guessing.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuChargesRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('MenuChargesResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/settings/currency': {
    patch: {
      tags: ['Menu'],
      summary: 'Change the menu currency',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description:
        'Roles: OWNER, MANAGER. Refused with 409 `MENU_CURRENCY_MISMATCH` while any active product is still priced in the old currency; prices are never converted automatically.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuCurrencyRequest') } } },
      responses: {
        200: { description: 'Changed.', content: { 'application/json': { schema: ref('MenuSettings') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/ocr-extract': {
    post: {
      tags: ['Menu'],
      summary: 'Read a menu from a photo or PDF',
      operationId: 'extractMenuFromUpload',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Upload one menu file as `multipart/form-data` in the field **`file`** — JPEG, PNG, WebP or',
        'PDF. A PDF is rasterised page by page, up to the configured page cap.',
        '',
        '**This writes nothing.** It returns a draft for a person to check, then',
        '`POST /api/v1/menu/ocr-import` commits what they confirmed. The division is deliberate and',
        'is the same one a declared Pago Móvil uses: OCR misreads prices, and a wrong price is',
        'charged to every diner who orders that dish until somebody notices.',
        '',
        'Rows the reader could not price arrive with `priceMinorUnits: null` and `needsPrice: true`',
        'rather than being dropped — the item is real, and hiding it sends staff hunting for what was',
        'missed. Rows sharing a name are flagged `duplicateName`, since the menu is unique on',
        '(restaurant, name).',
        '',
        'Rate limited to 10 per minute: each call costs money at a third party.',
        '',
        '503 `MENU_OCR_NOT_CONFIGURED` when the deployment has no vision provider configured. That is',
        'not a transient failure and retrying will not help — check `menuOcrAvailable` on',
        '`GET /api/v1/menu/settings` and hide the import instead. The server needs `MENU_OCR_API_KEY`;',
        '`MENU_OCR_BASE_URL` defaults to OpenAI and selects the vendor.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: { type: 'string', format: 'binary', description: 'JPEG, PNG, WebP or PDF. Bounded by MENU_OCR_MAX_UPLOAD_BYTES (8 MB default).' }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'The draft. Nothing was written.', content: { 'application/json': { schema: ref('MenuOcrDraft') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/menu/ocr-import': {
    post: {
      tags: ['Menu'],
      summary: 'Commit reviewed menu items',
      operationId: 'importMenuItems',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Writes the items a staff member confirmed. The extraction has no authority here — this body',
        'is equally valid having uploaded nothing, and is validated exactly like a hand-typed product.',
        '',
        'Products are created active, in the **restaurant\'s** menu currency; the request cannot name',
        'one, since that would allow a EUR product onto a VES menu.',
        '',
        '**Partial success is normal.** Each row is inserted inside its own savepoint, so one',
        'duplicate name rejects that row and keeps the rest — look at `errors` as well as',
        '`importedCount`.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuOcrImportRequest') } } },
      responses: {
        201: { description: 'What was imported, and what was not.', content: { 'application/json': { schema: ref('MenuOcrImportResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/categories': {
    get: {
      tags: ['Menu'],
      summary: 'List menu sections',
      description: [
        'Any authenticated staff role.',
        '',
        'Its own endpoint rather than a shape nested inside the product list, because the two are',
        'paginated differently: a client renders every section header at once and pages through the',
        'food underneath. Deriving the headers from one page of products would hide any section',
        'whose items fell past the limit.',
        '',
        '`uncategorisedCount` counts products filed under no section. They have no row here to',
        'appear under, and are precisely the ones somebody needs to notice.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'Sections in menu order.', content: { 'application/json': { schema: ref('MenuCategoryList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Menu'],
      summary: 'Create a menu section',
      description: [
        'OWNER and MANAGER.',
        '',
        'Until this existed the only way to get a section was an OCR import inventing them from the',
        'headings it read off a photograph — fine for a first menu, no use afterwards. A restaurant',
        'adding a dessert list had nowhere to say so.',
        '',
        'Omitting `position` files the section at the end of the menu, which is worked out here.',
        'Defaulting it to 0 instead would put every new section first and let the name tie-break',
        'decide the order.',
        '',
        'Names are unique per restaurant, and the collision is caught on the insert rather than',
        'pre-checked: SELECT-then-INSERT is a race, and two managers adding "Postres" at the same',
        'moment would both pass the check.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            position: { type: 'integer', minimum: 0, maximum: 9999, description: 'Omit for the end of the menu.' },
            active: { type: 'boolean', default: true }
          }
        } } }
      },
      responses: {
        201: { description: 'Created.', content: { 'application/json': { schema: ref('MenuCategory') } } },
        409: { description: 'A section with that name already exists.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/categories/order': {
    put: {
      tags: ['Menu'],
      summary: 'Reorder the menu sections',
      description: [
        'OWNER and MANAGER. The array *is* the order: `position` becomes the index.',
        '',
        'The whole order at once rather than one move at a time. Sending positions individually',
        'makes every intermediate state a state somebody could read — two sections both claiming',
        'position 3 while the next request is in flight — and a dropped request would leave the menu',
        'in one permanently.',
        '',
        'Applied inside a transaction. The statement matches only this restaurant\'s rows, so a list',
        'padded with another tenant\'s ids would reorder the rest and *then* fail; rolling back is',
        'what makes the 404 mean nothing happened.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: {
              type: 'array', minItems: 1, maxItems: 200, uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
              description: 'Every section, in the order they should appear.'
            }
          }
        } } }
      },
      responses: {
        204: { description: 'Reordered.' },
        404: { description: 'One or more sections do not exist. Nothing was changed.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/categories/{id}': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    patch: {
      tags: ['Menu'],
      summary: 'Rename, move or deactivate a section',
      description: [
        'OWNER and MANAGER. At least one field.',
        '',
        '`active: false` takes the whole section off the public menu with its products intact — the',
        'kitchen ran out of fish and the pescados block goes dark for the evening.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            position: { type: 'integer', minimum: 0, maximum: 9999 },
            active: { type: 'boolean' }
          }
        } } }
      },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('MenuCategory') } } },
        404: { description: 'No such section for this restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        409: { description: 'A section with that name already exists.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Delete a menu section',
      description: [
        'OWNER and MANAGER.',
        '',
        '**Deleting a section does not delete its food.** The foreign key is',
        '`ON DELETE SET NULL (category_id)`, so its products fall back into the uncategorised bucket,',
        'still active and still sellable. Taking the dishes with the heading would be a way to lose a',
        'menu by tidying it.'
      ].join('\n'),
      security: staff,
      responses: {
        204: { description: 'Deleted. Its products are now uncategorised.' },
        404: { description: 'No such section for this restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/branding/{kind}': {
    put: {
      tags: ['Menu'],
      summary: "Set the restaurant's cover photo or logo",
      operationId: 'setBranding',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`. JPEG, PNG or WebP.',
        '',
        'The shopfront a diner sees after scanning a table: the cover is wide and sits behind the',
        'name, the logo is square and sits on top of it. Both optional. Where they appear is the',
        'client\u2019s decision; the API stores two images and says where they are.',
        '',
        'A larger ceiling than a dish photo (`BRANDING_MAX_UPLOAD_BYTES`, 4 MB by default): a cover',
        'is a wide shot, and one that has to be cropped down usually ends up not uploaded at all.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: { file: { type: 'string', format: 'binary' } }
        } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('BrandingImage') } } },
        400: { description: 'Not a supported image, no file, too large, or an unknown kind.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove the cover photo or logo',
      operationId: 'deleteBranding',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'OWNER and MANAGER. 404 if there was none.',
      security: staff,
      parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/branding/{kind}': {
    get: {
      tags: ['Menu'],
      summary: "A restaurant's cover photo or logo, to a diner",
      operationId: 'getPublicBranding',
      description: [
        '**Unauthenticated**, like the public products beside it.',
        '',
        'Do not build this URL. Use `coverUrl` / `logoUrl` from the QR context or the public menu,',
        'which carry a `v=` suffix from the file\u2019s checksum \u2014 that is what makes a replaced image',
        'appear instead of the one a phone already cached, and what lets this be `immutable` for a',
        'year.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }
      ],
      responses: {
        200: {
          description: 'The image.',
          content: {
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } }
          }
        },
        304: { description: 'The client already has this image.' },
        404: { description: 'No image of that kind.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/products/{id}/image': {
    put: {
      tags: ['Menu'],
      summary: 'Set a dish photo',
      operationId: 'setProductImage',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`. JPEG, PNG or WebP.',
        '',
        'Optional per product, and always the restaurant\u2019s choice \u2014 a menu with no photographs must',
        'keep looking deliberate rather than unfinished. The ceiling is deliberately far below the',
        'menu PDF\u2019s: a PDF is fetched once by a diner who chose to open it, a dish photo by everyone',
        'at the table at once.',
        '',
        'The bytes are checked against the declared type, which catches a HEIC straight off an iPhone',
        'or a PDF dropped in the wrong box and says so plainly rather than storing something no',
        'browser will render.',
        '',
        'An upload replaces whatever was there; there is one photo per product. The **product** comes',
        'back, not the file, with `imageUrl` filled in so a screen can show the new photo without a',
        'second request.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: {
            file: {
              type: 'string', format: 'binary',
              description: 'JPEG, PNG or WebP, up to PRODUCT_IMAGE_MAX_UPLOAD_BYTES (2 MB by default).'
            }
          }
        } } }
      },
      responses: {
        200: { description: 'Stored. The product, with imageUrl.', content: { 'application/json': { schema: ref('Product') } } },
        400: { description: 'Not a supported image, no file, or too large.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove a dish photo',
      operationId: 'deleteProductImage',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'OWNER and MANAGER. Removes the photo and leaves the product alone. 404 if there was none.',
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/products/{productId}/image': {
    get: {
      tags: ['Menu'],
      summary: 'A dish photo, to a diner',
      operationId: 'getPublicProductImage',
      description: [
        '**Unauthenticated**, like the public products beside it: a diner scanning a table QR has no',
        'staff credentials, and this serves a picture the restaurant chose to publish.',
        '',
        'Do not build this URL. Use the `imageUrl` on the product, which carries a `v=` suffix taken',
        'from the file\u2019s checksum \u2014 that is what makes a replaced photo appear instead of the one a',
        'phone already cached. Because the address changes with the picture, the response is',
        '`immutable` for a year; an `ETag` is still sent for a client that arrives without the suffix.',
        '',
        'Scoped by both ids: a product belonging to another restaurant is a 404 rather than a picture,',
        'and a deactivated product takes its photo off the menu with it.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'productId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      responses: {
        200: {
          description: 'The photo.',
          content: {
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } }
          }
        },
        304: { description: 'The client already has this photo.' },
        404: { description: 'No photo, or not this restaurant\u2019s product.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/pdf': {
    get: {
      tags: ['Menu'],
      summary: 'The uploaded menu file, described',
      description: 'Any authenticated staff role. Metadata only — the panel needs to describe the file, not download it.',
      security: staff,
      responses: {
        200: { description: 'The stored file.', content: { 'application/json': { schema: ref('MenuDocument') } } },
        404: { description: 'Nothing uploaded.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    put: {
      tags: ['Menu'],
      summary: 'Upload the menu file shown to diners',
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`.',
        '',
        'Distinct from `/menu/ocr-extract`, which reads a menu in order to throw the file away and',
        'keep the prices. This keeps the file and shows it: a restaurant whose menu is a designed PDF',
        'gets something in front of a diner immediately, before anybody has typed in a price.',
        '',
        'It does not replace `menu_products`. A bill is built from priced rows, and nothing here can',
        'be added to one — the PDF is for reading.',
        '',
        'An upload replaces whatever was there; there is one file per restaurant. The bytes are',
        'checked for the `%PDF-` header as well as the declared type, which mostly catches somebody',
        'uploading a photo of the menu to the wrong route and says so plainly.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: { file: { type: 'string', format: 'binary', description: 'A PDF, up to MENU_PDF_MAX_UPLOAD_BYTES (20 MB by default).' } }
        } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('MenuDocument') } } },
        400: { description: 'Not a PDF, no file, or too large.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove the uploaded menu file',
      description: 'OWNER and MANAGER. The structured menu is untouched.',
      security: staff,
      responses: {
        204: { description: 'Removed.' },
        404: { description: 'Nothing uploaded.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/products': {
    get: {
      tags: ['Menu'],
      summary: 'List menu products',
      description: [
        'Any authenticated staff role.',
        '',
        'Ordered as the menu reads: section position, then the product\'s position within it, then',
        'name. Uncategorised products sort last. Name is the tie-break rather than the sort —',
        'everything imported at once shares a position, and alphabetical-within-a-section is a',
        'reasonable default until somebody reorders it.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } },
        {
          name: 'categoryId', in: 'query',
          schema: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'string', enum: ['none'] }] },
          description: 'Narrow to one section. `none` is the uncategorised bucket, which has no id and would otherwise be unreachable.'
        }
      ],
      responses: {
        200: { description: 'Products.', content: { 'application/json': { schema: ref('ProductList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Menu'],
      summary: 'Create a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. The currency comes from the restaurant, not the request.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateProductRequest') } } },
      responses: {
        201: { description: 'Created.', content: { 'application/json': { schema: ref('Product') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/products/order': {
    put: {
      tags: ['Menu'],
      summary: 'Reorder the products of one section',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. The array *is* the order: `position` becomes the index.',
        '',
        '`ids` must be exactly the products of that section — every one of them, and no other. A',
        'missing id, one from another section or one from another restaurant changes nothing and',
        'answers 404. Accepting part of a section would leave two products sharing a position and',
        'the name deciding between them, which is what reordering is for removing.',
        '',
        '`categoryId: null` orders the products that have no section. A product created or moved',
        'into a section goes to its end.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['categoryId', 'ids'],
          properties: {
            categoryId: { type: ['string', 'null'], format: 'uuid', description: 'The section, or null for the products without one.' },
            ids: {
              type: 'array', minItems: 1, maxItems: 500, uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
              description: 'Every product of the section, in the order they should appear.'
            }
          }
        } } }
      },
      responses: {
        204: { description: 'Reordered.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: { description: 'The list is not exactly that section. Nothing was changed.', content: { 'application/json': { schema: ref('Error') } } }
      }
    }
  },

  '/api/v1/menu/products/{id}': {
    patch: {
      tags: ['Menu'],
      summary: 'Update a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Partial update; at least one field is required.',
        '',
        'Changing the tax fields affects only bills opened afterwards. Every line freezes its own',
        'taxCategory and vatBps when it is added, exactly as it freezes the price, so declaring a',
        'dish exempt today does not move the IVA on a meal already served.',
        '',
        'Moving a product to a non-taxable category clears any vatBps it carried — that is what the',
        'change means. Sending a vatBps for a product whose stored category is not TAXABLE is refused',
        'with 409 `PRODUCT_TAX_CONFLICT`; change taxCategory in the same request, or first.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/ProductId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateProductRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('Product') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Deactivates by default — a bill already referencing the product',
        'must stay readable.',
        '',
        '`?permanent=true` deletes the row outright. That is safe: `bill_items.product_id` is',
        'ON DELETE SET NULL and every line carries its own name and price snapshot, so an old bill',
        'stays exactly as it was served and only loses the reporting link. Use it to clear products',
        'left behind by a menu-currency change.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/ProductId' },
        { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } }
      ],
      responses: {
        204: { description: 'Deactivated.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },
};

module.exports = { publicMenu };
