const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCsv, textCell, money, rateLabel, parseMonth } = require('../src/services/fiscalExport');

/**
 * La hoja del contador, sin base de datos.
 *
 * Lo que se comprueba aquí es lo que decide si el fichero dice la verdad: que
 * cada alícuota tenga su columna, que una nota de crédito reste, que los
 * importes se lean como números en un Excel en español y que el nombre que
 * escribió un comensal no se ejecute como fórmula.
 */
const doc = (over = {}) => ({
  id: 'x',
  document_type: 'INVOICE',
  document_number: 'F-00000001',
  control_number: '00-00000001',
  provider: 'own',
  subtotal_minor: '10000',
  vat_minor: '1600',
  service_minor: '1000',
  total_minor: '12600',
  customer_name: null,
  customer_tax_id: null,
  issued_date: '30/09/2026',
  compensates_number: null,
  table_name: 'Mesa 12',
  taxes: [{ tax_category: 'TAXABLE', vat_bps: 1600, base_minor: '10000', vat_minor: '1600' }],
  ...over
});

const parse = csv => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n').map(l => l.split(';'));

describe('exportación de facturas a CSV', () => {
  it('abre con BOM y separa con punto y coma', () => {
    const csv = buildCsv([doc()]);
    assert.ok(csv.startsWith('\uFEFF'), 'sin BOM, Excel lee «Nº» como «NÂº»');
    const [header, row] = parse(csv);
    assert.equal(header[0], 'Fecha');
    assert.equal(row.length, header.length, 'cada fila tiene tantas celdas como la cabecera');
  });

  it('una columna de base y otra de IVA por cada alícuota que aparece', () => {
    const csv = buildCsv([
      doc(),
      doc({
        document_number: 'F-00000002',
        taxes: [
          { tax_category: 'TAXABLE', vat_bps: 800, base_minor: '5000', vat_minor: '400' },
          { tax_category: 'EXEMPT', vat_bps: 0, base_minor: '2000', vat_minor: '0' }
        ]
      })
    ]);
    const [header, first, second] = parse(csv);
    for (const col of ['Base 16% (Bs)', 'IVA 16% (Bs)', 'Base 8% (Bs)', 'IVA 8% (Bs)', 'Exento o no sujeto (Bs)']) {
      assert.ok(header.includes(col), `falta la columna ${col}`);
    }
    const at = (row, col) => row[header.indexOf(col)];
    assert.equal(at(first, 'Base 16% (Bs)'), '100,00');
    assert.equal(at(first, 'Base 8% (Bs)'), '0,00');
    assert.equal(at(second, 'Base 8% (Bs)'), '50,00');
    assert.equal(at(second, 'IVA 8% (Bs)'), '4,00');
    assert.equal(at(second, 'Exento o no sujeto (Bs)'), '20,00');
  });

  it('una nota de crédito resta, con el número de la factura que compensa', () => {
    const [header, , note] = parse(buildCsv([
      doc(),
      doc({ document_type: 'CREDIT_NOTE', document_number: 'NC-1', compensates_number: 'F-00000001' })
    ]));
    const at = col => note[header.indexOf(col)];
    assert.equal(at('Tipo'), 'Nota de crédito');
    assert.equal(at('Documento afectado'), 'F-00000001');
    assert.equal(at('Total (Bs)'), '-126,00', 'sumar la columna tiene que dar la venta neta');
    assert.equal(at('Base 16% (Bs)'), '-100,00');
  });

  it('importes sin separador de miles y con coma decimal', () => {
    assert.equal(money('123456789'), '1234567,89');
    assert.equal(money('5'), '0,05');
    assert.equal(money('0'), '0,00');
    assert.equal(money('150', -1n), '-1,50');
  });

  it('el nombre de un comensal no se ejecuta como fórmula', () => {
    // CSV injection: lo que empieza por = + - @ lo evalúa la hoja al abrirla.
    assert.equal(textCell('=HYPERLINK("http://x","clic")'), '"\'=HYPERLINK(""http://x"",""clic"")"');
    assert.equal(textCell('+58 412'), "'+58 412");
    assert.equal(textCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(textCell('-2+3'), "'-2+3");
    const [, row] = parse(buildCsv([doc({ customer_name: '=1+1', customer_tax_id: 'V12345678' })]));
    assert.ok(row.includes("'=1+1"));
  });

  it('un punto y coma o unas comillas dentro de un texto no rompen la fila', () => {
    assert.equal(textCell('Pérez; Hnos. "El Rápido"'), '"Pérez; Hnos. ""El Rápido"""');
  });

  it('sin receptor es consumidor final; los de prueba se marcan', () => {
    const [header, row] = parse(buildCsv([doc({ provider: 'mock' })]));
    assert.equal(row[header.indexOf('Cliente')], 'Consumidor final');
    assert.equal(row[header.indexOf('Documento de prueba')], 'Sí');
  });

  it('un mes vacío es una cabecera, no un error', () => {
    const rows = parse(buildCsv([]));
    assert.equal(rows.length, 1);
  });

  it('alícuotas y meses', () => {
    assert.equal(rateLabel(1600), '16%');
    assert.equal(rateLabel(1250), '12,5%');
    assert.deepEqual(parseMonth('2026-09'), { year: 2026, month: 9 });
    assert.equal(parseMonth('2026-13'), null);
    assert.equal(parseMonth('2026-9'), null);
  });
});
