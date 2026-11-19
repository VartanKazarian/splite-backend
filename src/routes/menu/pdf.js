/** A restaurant's own PDF menu, for those who would rather show that. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const config = require('../../config');
const rateLimit = require('../../middleware/rateLimit');
const multer = require('multer');
const { MULTIPART_LIMITS, handleUpload } = require('./shared');

const router = express.Router();

/**
 * The uploaded menu, which is a different kind of file from the OCR one.
 *
 * Its own limit because the two are bounded by different things: what a vision
 * model should be asked to read, against what a diner on mobile data should be
 * asked to download.
 */
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...MULTIPART_LIMITS, fileSize: config.menuPdf.maxUploadBytes }
});

/**
 * The restaurant's own menu file, kept as-is.
 *
 * Distinct from `/ocr-extract`, which reads a menu in order to throw the file
 * away and keep the prices. This one keeps the file and shows it: a restaurant
 * whose menu is a designed PDF gets something in front of a diner immediately,
 * without anybody transcribing it first.
 *
 * It does not replace `menu_products`. A bill is built from priced rows, and
 * nothing here can be added to one -- the PDF is for reading.
 */
const PDF_MEDIA = 'application/pdf';

/** Metadata only. The bytes are large and the panel only needs to describe them. */
router.get('/pdf', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT restaurant_id, content_type, filename, size_bytes, updated_at
         FROM menu_documents WHERE restaurant_id = $1`,
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('MENU_PDF_NOT_FOUND', 'No menu file uploaded');
    res.json(dto.menuDocument(rows[0]));
  } catch (err) { next(err); }
});

router.put(
  '/pdf',
  requireRole('OWNER', 'MANAGER'),
  rateLimit({ windowSeconds: 300, max: 20, keyPrefix: 'menu:pdf' }),
  handleUpload(
    pdfUpload.single('file'), 'MENU_PDF_FILE_TOO_LARGE', config.menuPdf.maxUploadBytes
  ),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError('MENU_PDF_FILE_REQUIRED', 'A file is required');

      // The declared type is a claim by the client, so the bytes are checked
      // too: every PDF begins %PDF-. This is not a security boundary -- the
      // file is served back with its own Content-Type and never executed -- but
      // it catches the common mistake of uploading a photo of the menu here
      // rather than to the OCR route, and says so plainly.
      const declared = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();
      const looksPdf = req.file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
      if (declared !== PDF_MEDIA || !looksPdf) {
        throw new ApiError('MENU_PDF_UNSUPPORTED_MEDIA', 'Only PDF files are accepted', {
          contentType: declared || 'unknown'
        });
      }

      const { rows } = await db.query(
        `INSERT INTO menu_documents (restaurant_id, bytes, content_type, filename, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (restaurant_id) DO UPDATE
           SET bytes = EXCLUDED.bytes,
               content_type = EXCLUDED.content_type,
               filename = EXCLUDED.filename,
               size_bytes = EXCLUDED.size_bytes
         RETURNING restaurant_id, content_type, filename, size_bytes, updated_at`,
        [
          req.user.restaurantId,
          req.file.buffer,
          PDF_MEDIA,
          // A filename from a stranger, used only as a label and as the
          // download name. Stripped to its basename so nothing resembling a
          // path survives, and bounded so it cannot be a payload.
          String(req.file.originalname || 'carta.pdf').replace(/^.*[\\/]/, '').slice(0, 160),
          req.file.size
        ]
      );

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PDF_UPLOADED',
        resourceType: 'menu_document',
        resourceId: req.user.restaurantId
      });

      res.json(dto.menuDocument(rows[0]));
    } catch (err) { next(err); }
  }
);

router.delete('/pdf', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM menu_documents WHERE restaurant_id = $1 RETURNING restaurant_id',
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('MENU_PDF_NOT_FOUND', 'No menu file uploaded');

    await logAudit({
      ...auditContext(req),
      action: 'MENU_PDF_DELETED',
      resourceType: 'menu_document',
      resourceId: req.user.restaurantId
    });

    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
