/** What more than one part of /menu needs: column lists, upload limits and the image plumbing. */
const { ApiError } = require('../../errors');

/**
 * Lo que un envío multipart puede traer, además del tamaño del fichero.
 *
 * Los cuatro puntos de subida ya acotaban `fileSize` y `files`, que es lo que
 * evita que alguien mande un gigabyte o veinte ficheros. Lo que no acotaban es
 * **todo lo demás del sobre**: sin `fields`, `parts` y `fieldNestingDepth`, un
 * cliente puede mandar un fichero diminuto acompañado de cien mil campos, o de
 * nombres anidados como `a[b][c][d]...`, y el analizador los recorre antes de
 * que ninguna validación nuestra llegue a ejecutarse.
 *
 * Ninguno de estos cuatro endpoints recibe campos anidados: son un fichero y,
 * como mucho, un par de campos planos al lado. Los valores son los de eso con
 * holgura, no los del máximo imaginable.
 */
const MULTIPART_LIMITS = Object.freeze({
  files: 1,
  // Campos de texto junto al fichero. El frontend manda cero o uno.
  fields: 8,
  // Ficheros + campos. Con tope propio para que ni sumándolos se dispare.
  parts: 12,
  // `a[b][c]` son tres niveles. Aquí no se usa ninguno; cinco es holgura.
  fieldNestingDepth: 5,
  // Un nombre de campo largo no dice nada bueno.
  fieldNameSize: 100,
  // Un valor de campo de texto. Nada de lo que mandamos se acerca.
  fieldSize: 8 * 1024
});

/**
 * Multer's own rejections, translated.
 *
 * Left alone they surface as a 500 on a request whose only fault is an
 * oversized file, and the caller is told nothing it can act on.
 */
function handleUpload(handler, tooLargeCode, maxBytes) {
  return (req, res, next) => handler(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(tooLargeCode, 'File is too large', { maxBytes }));
    }
    if (err) return next(err);
    return next();
  });
}

/**
 * The order a menu is read in.
 *
 * Section first, then the item's place inside it, then name. Name is the
 * tie-break rather than the sort: everything imported at once shares position
 * 0, and alphabetical-within-a-section is a reasonable default until somebody
 * reorders it. NULLS LAST puts uncategorised products after every named
 * section, which is where a reviewer expects to find the ones still to be
 * filed rather than scattered through the list.
 */
const MENU_ORDER = `c.position NULLS LAST, c.name NULLS LAST, p.position, p.name`;

/**
 * Whether a product has a photo, and which one, without touching the bytes.
 *
 * Selected as two scalars off a LEFT JOIN rather than by fetching the file: a
 * menu listing is the query a diner's phone makes, and it must not carry a
 * megabyte per dish. `dto.product` turns the pair into a URL -- the checksum
 * rides on the query string so that replacing a photo changes the address and a
 * cached phone stops showing the old dish.
 */
const IMAGE_COLUMNS = `(pi.product_id IS NOT NULL) AS has_image, pi.checksum AS image_checksum`;

const IMAGE_JOIN = `LEFT JOIN menu_product_images pi
             ON pi.product_id = p.id AND pi.restaurant_id = p.restaurant_id`;

module.exports = { MULTIPART_LIMITS, handleUpload, MENU_ORDER, IMAGE_COLUMNS, IMAGE_JOIN };
