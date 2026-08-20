const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const { ApiError } = require('../errors');
const { logger } = require('../connectors/logger');
const { parseMenuPrice } = require('./menuPrice');

const execFileAsync = promisify(execFile);

/**
 * Reading a menu off a photograph or a PDF.
 *
 * A vision model proposes; a person disposes. Nothing here writes to the
 * database, and that is the design rather than an omission -- it is the same
 * shape as a declared Pago Móvil, where the machine records a claim and a human
 * turns it into a fact. OCR misreads prices, and a wrong price on a menu is
 * charged to every diner who orders that dish until somebody notices.
 *
 * So this returns a draft. `POST /menu/ocr-import` is the write, and it takes
 * what the staff member confirmed, not what the model said.
 *
 * The provider is reached with plain `fetch`, matching the Mercantil adapter
 * rather than pulling in an SDK: the same timeout, the same
 * "not configured is a 503 not a 500", and the same rule that a body we cannot
 * read is reported rather than guessed at.
 */

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PDF_TYPE = 'application/pdf';

/** What the model is asked for. Kept here so a prompt change is reviewable. */
const PROMPT = [
  'You are reading a restaurant menu. Extract every dish or drink that has a price.',
  '',
  'For each item return:',
  '  name        the item exactly as printed, in its original language',
  '  priceText   the price exactly as printed, including separators ("12,50", "Bs. 8,00", "25.00")',
  '  description any subtitle or ingredient line, or null',
  '  section     the heading it appears under ("Entradas", "Bebidas"), or null',
  '',
  'Rules:',
  '  - Never invent a price. If an item has no readable price, set priceText to null.',
  '  - Do not convert or reformat prices. Copy the characters as printed.',
  '  - Skip headings, footers, addresses and phone numbers.',
  '',
  'Return only JSON: {"items":[{"name","priceText","description","section"}],',
  '"currencyGuess":"VES"|"USD"|"EUR"|null,"notes":"anything illegible"}'
].join('\n');

const isConfigured = () => Boolean(config.menuOcr.apiKey && config.menuOcr.baseUrl);

/**
 * Turns an upload into the images the model will see.
 *
 * A PDF is rasterised page by page with `pdftoppm`, because a menu PDF is
 * usually a design export whose text layer is either absent or ordered by
 * drawing position rather than reading order -- the layout is the information,
 * and a picture preserves it where extracted text does not.
 *
 * Bounded on every axis that an untrusted file controls: page count, a hard
 * timeout on the converter, and a disposable directory removed in `finally`.
 */
async function toImages({ buffer, contentType }) {
  if (SUPPORTED_IMAGE_TYPES.has(contentType)) {
    return [{ base64: buffer.toString('base64'), mediaType: contentType }];
  }
  if (contentType !== PDF_TYPE) {
    throw new ApiError('MENU_OCR_UNSUPPORTED_MEDIA', 'Upload a JPEG, PNG, WebP or PDF menu', {
      contentType
    });
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'splite-menu-'));
  try {
    const input = path.join(dir, 'menu.pdf');
    await fs.writeFile(input, buffer);

    try {
      await execFileAsync(
        'pdftoppm',
        ['-png', '-r', '150', '-f', '1', '-l', String(config.menuOcr.maxPdfPages),
          input, path.join(dir, 'page')],
        { timeout: config.menuOcr.pdfTimeoutMs, maxBuffer: 1024 * 1024 }
      );
    } catch (err) {
      // A PDF we cannot rasterise is the caller's problem to fix (re-export, or
      // photograph the page), not a server fault.
      logger.warn({ event: 'MENU_OCR_PDF_UNREADABLE', err }, 'pdftoppm could not read the upload');
      throw new ApiError('MENU_OCR_PDF_UNREADABLE',
        'That PDF could not be read. Try exporting it again, or upload a photo of the menu.');
    }

    const pages = (await fs.readdir(dir))
      .filter(name => name.endsWith('.png'))
      .sort();
    if (!pages.length) {
      throw new ApiError('MENU_OCR_PDF_UNREADABLE', 'That PDF contained no readable pages');
    }

    return Promise.all(pages.map(async name => ({
      base64: (await fs.readFile(path.join(dir, name))).toString('base64'),
      mediaType: 'image/png'
    })));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Asks the vision model to read the pages.
 *
 * Isolated behind one function so the provider is a configuration choice rather
 * than a rewrite: the request shape is the OpenAI-compatible chat-completions
 * body that several vendors now serve, and `MENU_OCR_BASE_URL` selects which.
 */
async function callVisionModel(images) {
  if (!isConfigured()) {
    throw new ApiError('MENU_OCR_NOT_CONFIGURED',
      'Menu OCR is not configured for this deployment');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.menuOcr.timeoutMs);
  try {
    const response = await fetch(new URL('/v1/chat/completions', config.menuOcr.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.menuOcr.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.menuOcr.model,
        max_tokens: config.menuOcr.maxTokens,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            ...images.map(image => ({
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${image.base64}` }
            }))
          ]
        }]
      })
    });

    const text = await response.text();
    if (!response.ok) {
      // The body may quote the request back; it is a menu, not a secret, but it
      // is also large, so only the status travels into the log.
      logger.warn({ event: 'MENU_OCR_PROVIDER_REJECTED', status: response.status },
        'Vision provider rejected the request');
      throw new ApiError('MENU_OCR_UNAVAILABLE', 'The menu reader is unavailable; try again', {
        retryAfterSeconds: 30
      });
    }

    let payload;
    try {
      payload = JSON.parse(JSON.parse(text).choices[0].message.content);
    } catch {
      throw new ApiError('MENU_OCR_UNREADABLE_RESPONSE',
        'The menu reader returned something unreadable; try again');
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') {
      throw new ApiError('MENU_OCR_UNAVAILABLE', 'The menu reader timed out; try again', {
        retryAfterSeconds: 30
      });
    }
    logger.warn({ event: 'MENU_OCR_CALL_FAILED', err }, 'Vision provider call failed');
    throw new ApiError('MENU_OCR_UNAVAILABLE', 'The menu reader is unavailable; try again', {
      retryAfterSeconds: 30
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shapes what the model returned into rows a review screen can render.
 *
 * Every row carries `priceText` as printed *and* the parsed `priceMinorUnits`,
 * because the reviewer is checking one against the other. A price that could
 * not be parsed arrives as null with `needsPrice: true` rather than being
 * dropped: the item is real, and hiding it would send staff hunting for what
 * the reader missed.
 */
function toDraftItems(payload, { currency }) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const drafts = [];

  for (const item of items) {
    const name = String(item?.name ?? '').trim().slice(0, 160);
    if (!name) continue;                                  // a row with no name is not an item

    const priceText = item?.priceText == null ? null : String(item.priceText).trim();
    const priceMinorUnits = parseMenuPrice(priceText);

    drafts.push({
      name,
      description: item?.description ? String(item.description).trim().slice(0, 500) : null,
      section: item?.section ? String(item.section).trim().slice(0, 80) : null,
      priceText,
      priceMinorUnits,
      needsPrice: priceMinorUnits === null,
      currency
    });
  }

  // Two rows with one name cannot both be imported -- menu_products is unique
  // on (restaurant_id, name) -- so it is flagged here, where the reviewer can
  // rename one, rather than surfacing as a duplicate-key error on import.
  const seen = new Map();
  for (const draft of drafts) {
    const key = draft.name.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const draft of drafts) {
    draft.duplicateName = seen.get(draft.name.toLowerCase()) > 1;
  }

  return drafts;
}

/**
 * The whole read: upload in, draft rows out. Writes nothing.
 *
 * `visionClient` is injectable so the mapping, the parsing and the flagging can
 * be tested without a provider -- the part worth testing is what we do with the
 * answer, not the network call.
 */
async function extractMenu({ buffer, contentType, currency, visionClient = callVisionModel }) {
  const images = await toImages({ buffer, contentType });
  const payload = await visionClient(images);
  const items = toDraftItems(payload, { currency });

  return {
    items,
    pages: images.length,
    // Reported, never applied: the menu currency is the restaurant's setting,
    // and a menu printed in dollars does not change what this restaurant
    // charges in. A mismatch is for the reviewer to notice.
    currencyGuess: payload?.currencyGuess ?? null,
    currency,
    notes: payload?.notes ? String(payload.notes).slice(0, 500) : null,
    needsReview: items.filter(item => item.needsPrice || item.duplicateName).length
  };
}

module.exports = {
  extractMenu, toDraftItems, toImages, isConfigured,
  SUPPORTED_IMAGE_TYPES, PDF_TYPE, PROMPT
};
