const PDFDocument = require('pdfkit');

const { formatRif } = require('../utils/rif');
const { _internals: { money, rate, quantity }, BASIS_NOTE } = require('./fiscalMail');

/**
 * Una factura ya emitida, en PDF, para que el restaurante la guarde o la
 * imprima.
 *
 * Es **el mismo documento** que recibe el cliente por correo, en otro formato:
 * sale de `fiscalMail.load`, con las mismas cifras formateadas por las mismas
 * funciones. Dos representaciones de una factura que salieran de dos consultas
 * acabarían diciendo cosas distintas, y ésta es la que se enseña si hay una
 * inspección.
 *
 * No emite ni cambia nada: un documento fiscal es inmutable, y esto sólo lo
 * dibuja. Por eso puede pedirse cuantas veces haga falta.
 *
 * Los documentos del proveedor simulado llevan la advertencia arriba y en rojo,
 * igual que su correo: un PDF con números inventados que pareciera una factura
 * es exactamente lo que no puede salir de aquí.
 */

const TITLES = {
  INVOICE: 'FACTURA',
  CREDIT_NOTE: 'NOTA DE CRÉDITO',
  DEBIT_NOTE: 'NOTA DE DÉBITO'
};

const INK = '#1f1d1a';
const MUTED = '#6b655d';
const RULE = '#d9d4cc';

/** El nombre del fichero, sin nada que un sistema de archivos no acepte. */
function filenameFor(invoice) {
  const kind = invoice.document_type === 'INVOICE' ? 'factura' : 'nota';
  const number = String(invoice.document_number ?? invoice.id).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${kind}-${number}.pdf`;
}

function render({ invoice, restaurant, lines, taxes, tableName }) {
  return new Promise((resolve, reject) => {
    const simulated = invoice.provider === 'mock';
    const title = TITLES[invoice.document_type] ?? 'FACTURA';
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      info: {
        Title: `${title} ${invoice.document_number} — ${restaurant.name}`,
        Author: restaurant.name,
        Subject: simulated ? 'Documento de prueba' : `Nº de control ${invoice.control_number}`
      }
    });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    let y = doc.page.margins.top;

    const rule = () => {
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor(RULE).stroke();
      y += 10;
    };
    // Una fila que no cabe empieza página nueva en vez de salirse por abajo.
    const room = (needed) => {
      if (y + needed <= bottom()) return;
      doc.addPage();
      y = doc.page.margins.top;
    };

    if (simulated) {
      doc.rect(left, y, width, 38).fill('#fdecec');
      doc.fillColor('#b42318').font('Helvetica-Bold').fontSize(11)
        .text('DOCUMENTO DE PRUEBA — NO ES UNA FACTURA FISCAL', left + 12, y + 8, { width: width - 24 });
      doc.font('Helvetica').fontSize(8.5)
        .text('Lo emitió un proveedor simulado y sus números son inventados. No tiene validez ante el SENIAT.',
          left + 12, y + 23, { width: width - 24 });
      y += 52;
    }

    // Emisor, a la izquierda; qué documento es, a la derecha.
    const headTop = y;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16)
      .text(restaurant.name, left, y, { width: width * 0.48 });
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
    if (restaurant.rif) { doc.text(`RIF ${formatRif(restaurant.rif)}`, left, y, { width: width * 0.48 }); y = doc.y; }
    if (restaurant.fiscal_address) {
      doc.text(restaurant.fiscal_address, left, y, { width: width * 0.48 }); y = doc.y;
    }
    const leftEnd = y;

    // Un número de control no se parte en dos líneas: es lo que se copia a mano
    // en una declaración. La etiqueta va a ancho fijo y el valor se queda el resto.
    const rw = width * 0.5;
    const rx = left + width - rw;
    const labelW = 72;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(title, rx, headTop, { width: rw, align: 'right' });
    let ry = doc.y + 4;
    const meta = [
      ['Nº', invoice.document_number],
      ['Nº de control', invoice.control_number],
      ['Fecha', new Date(invoice.issued_at).toISOString().slice(0, 10)],
      ...(tableName ? [['Mesa', tableName]] : [])
    ];
    doc.fontSize(9.5);
    for (const [label, value] of meta) {
      doc.font('Helvetica').fillColor(MUTED).text(label, rx, ry, { width: labelW });
      doc.font('Helvetica-Bold').fillColor(INK).text(String(value ?? '—'), rx + labelW, ry, { width: rw - labelW, align: 'right' });
      ry = doc.y + 2;
    }
    y = Math.max(leftEnd, ry) + 14;
    rule();

    // Receptor. Consumidor final se escribe como tal, no como un hueco.
    const named = invoice.customer_name || invoice.customer_tax_id;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('RECEPTOR', left, y);
    y = doc.y + 2;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
      .text(named ? [invoice.customer_name, invoice.customer_tax_id].filter(Boolean).join(' · ') : 'Consumidor final', left, y, { width });
    y = doc.y;
    if (invoice.customer_email) {
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(invoice.customer_email, left, y, { width });
      y = doc.y;
    }
    y += 12;
    rule();

    // Detalle.
    const qtyW = 60;
    const amtW = 110;
    const descX = left + qtyW;
    const descW = width - qtyW - amtW;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    doc.text('CANT.', left, y, { width: qtyW });
    doc.text('DESCRIPCIÓN', descX, y, { width: descW });
    doc.text('BASE (Bs)', left + width - amtW, y, { width: amtW, align: 'right' });
    y = doc.y + 6;

    doc.fontSize(10).fillColor(INK);
    for (const line of lines) {
      const h = doc.heightOfString(line.description, { width: descW - 8 });
      room(h + 6);
      doc.font('Helvetica').text(quantity(line.quantity_milli), left, y, { width: qtyW });
      doc.text(line.description, descX, y, { width: descW - 8 });
      doc.text(money(line.base_minor), left + width - amtW, y, { width: amtW, align: 'right' });
      y += Math.max(h, 12) + 6;
    }
    y += 4;
    rule();

    // Impuestos, por alícuota: es lo que el documento declara.
    room(40 + taxes.length * 14);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('IMPUESTOS', left, y);
    y = doc.y + 4;
    doc.fontSize(9.5).fillColor(INK);
    for (const tax of taxes) {
      const label = Number(tax.vat_bps) === 0 ? 'Sin IVA' : `IVA ${rate(Number(tax.vat_bps))}`;
      doc.text(`${label} · base ${money(tax.base_minor)} Bs`, left, y, { width: width - amtW });
      doc.text(money(tax.vat_minor), left + width - amtW, y, { width: amtW, align: 'right' });
      y = doc.y + 3;
    }
    y += 8;

    // Totales, alineados a la derecha.
    const totals = [
      ['Base imponible', invoice.subtotal_minor],
      ['IVA', invoice.vat_minor],
      ...(BigInt(invoice.service_minor) > 0n ? [['Servicio', invoice.service_minor]] : [])
    ];
    room(30 + totals.length * 15);
    const tx = left + width * 0.5;
    const tw = width * 0.5;
    doc.fontSize(10);
    for (const [label, amount] of totals) {
      doc.font('Helvetica').fillColor(MUTED).text(label, tx, y, { width: tw - amtW });
      doc.fillColor(INK).text(`${money(amount)} Bs`, tx + tw - amtW, y, { width: amtW, align: 'right' });
      y = doc.y + 3;
    }
    y += 3;
    doc.moveTo(tx, y).lineTo(left + width, y).lineWidth(0.8).strokeColor(INK).stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('TOTAL', tx, y, { width: tw - amtW });
    doc.text(`${money(invoice.total_minor)} Bs`, tx + tw - amtW, y, { width: amtW, align: 'right' });
    y = doc.y + 18;

    const note = BASIS_NOTE[invoice.line_basis];
    if (note) {
      room(30);
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(note, left, y, { width });
    }

    doc.end();
  });
}

module.exports = { render, filenameFor };
