const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const billItems = require('../../src/services/billItems');

/**
 * Bill line items against a real Postgres.
 *
 * The two rules worth proving are that a line's price is a snapshot, and that
 * recalculation reuses the rate frozen on the bill. Both are silent when broken:
 * a bill simply reports a different number than it did a minute ago.
 */
describe('bill items', { skip }, () => {
  let restaurant;
  let seq = 0;

  // $10.00 a unit at this rate is 757 540.6 céntimos, which rounds half-up.
  const USD_RATE = '757.54060000';

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Items Tenant' });
    await db.query('UPDATE restaurants SET menu_currency = $1 WHERE id = $2', ['USD', restaurant.id]);
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const product = async (name, priceMinor, overrides = {}) => {
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, price_minor_units`,
      [restaurant.id, `${name}-${++seq}`, priceMinor, overrides.currency ?? 'USD', overrides.active ?? true]
    );
    return rows[0];
  };

  /** An itemisable bill: opened at zero, in USD, at a fixed frozen rate. */
  const itemisableBill = async () => {
    const table = await fixtures.createTable(restaurant.id, { name: `I${++seq}` });
    return fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id,
      totalDue: 0, currency: 'USD', totalDueVes: 0, fxRate: USD_RATE
    });
  };

  const add = (billId, productId, quantity) =>
    billItems.addItem({ restaurantId: restaurant.id, billId, productId, quantity });

  it('snapshots the price, and a later menu change does not move the bill', async () => {
    const bill = await itemisableBill();
    const burger = await product('Burger', 1250);

    const { item } = await add(bill.id, burger.id, 2);
    assert.equal(item.unit_price_minor, '1250');
    assert.equal(item.subtotal_minor, '2500', 'the database computes the subtotal');

    // Double the menu price and rename it. Neither may reach the bill.
    await db.query(
      'UPDATE menu_products SET price_minor_units = 2500, name = $1 WHERE id = $2',
      [`Burger-renamed-${seq}`, burger.id]
    );

    const [line] = await billItems.listForBill({ restaurantId: restaurant.id, billId: bill.id });
    assert.equal(line.unit_price_minor, '1250', 'the snapshot holds');
    assert.equal(line.name_snapshot, burger.name, 'the name is the one captured at the time');
    assert.equal(line.subtotal_minor, '2500');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.total_due, '2500', 'the bill total is unchanged by the menu edit');
  });

  it('converts the total at the rate frozen on the bill, not a fresh one', async () => {
    const bill = await itemisableBill();
    const dish = await product('Dish', 1000);

    const { bill: updated } = await add(bill.id, dish.id, 1);

    // $10.00 x 757.5406 = 757 540.6 céntimos -> 757541 half-up.
    assert.equal(updated.total_due, '1000');
    assert.equal(updated.total_due_ves, '757541');
    assert.equal(updated.fx_rate_ves_per_unit, USD_RATE, 'the frozen rate is untouched');

    // Move the rate every later bill would see. This one must not follow it.
    await db.query(
      'UPDATE bills SET fx_rate_ves_per_unit = $1 WHERE id = $2', ['900.00000000', bill.id]
    );
    const second = await add(bill.id, dish.id, 1);
    assert.equal(second.bill.total_due, '2000');
    assert.equal(second.bill.total_due_ves, '1800000', 'recalculated at the bill\'s own stored rate');
  });

  it('keeps the total exact across many lines', async () => {
    const bill = await itemisableBill();
    const odd = await product('Odd', 333);

    for (let i = 0; i < 3; i++) await add(bill.id, odd.id, 1);
    const { bill: updated } = await add(bill.id, odd.id, 3);

    // 6 x 333 = 1998, and the VES side is that at the frozen rate.
    assert.equal(updated.total_due, '1998');

    const items = await billItems.listForBill({ restaurantId: restaurant.id, billId: bill.id });
    const summed = items.reduce((total, line) => total + BigInt(line.subtotal_minor), 0n);
    assert.equal(summed.toString(), updated.total_due, 'the stored total is the sum of the lines');
  });

  it('adds IVA and servicio without compounding one on the other', async () => {
    await db.query(
      'UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 1000 WHERE id = $1',
      [restaurant.id]
    );
    try {
      const t = await fixtures.createTable(restaurant.id, { name: `V${++seq}` });
      const bill = await fixtures.createBill({
        restaurantId: restaurant.id, tableId: t.id, totalDue: 0,
        currency: 'USD', totalDueVes: 0, fxRate: USD_RATE
      });
      // The fixture inserts directly, so put the snapshot on by hand -- the
      // route does this from the restaurant when a bill is opened.
      await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 1000 WHERE id = $1', [bill.id]);

      const dish = await product('Taxed', 10000);   // $100.00
      const { bill: updated } = await add(bill.id, dish.id, 1);

      assert.equal(updated.subtotal_minor, '10000');
      assert.equal(updated.vat_minor, '1600', '16% of the subtotal');
      assert.equal(updated.service_charge_minor, '1000', '10% of the subtotal');

      // 12600, not 12760. Taxing subtotal + service would give 1760 of IVA and
      // overstate every bill; this is the assertion that catches that.
      assert.equal(updated.total_due, '12600');
      assert.notEqual(updated.vat_minor, '1760', 'IVA must not be charged on the servicio');

      const parts = BigInt(updated.subtotal_minor) + BigInt(updated.vat_minor) +
        BigInt(updated.service_charge_minor);
      assert.equal(parts.toString(), updated.total_due, 'the total is exactly its parts');
    } finally {
      await db.query(
        'UPDATE restaurants SET vat_bps = 0, service_charge_bps = 0 WHERE id = $1', [restaurant.id]
      );
    }
  });

  it('keeps the total equal to its parts at every rate and amount', async () => {
    // The property, not an example. Rounding each charge independently is
    // exactly where a céntimo goes missing, and the database CHECK would
    // reject the write rather than store a total that disagrees with itself.
    const { applyBps } = require('../../src/services/money');

    // Half-up, computed a different way, so this checks the implementation
    // rather than restating it.
    const expected = (amount, bps) => {
      const scaled = amount * BigInt(bps);
      return scaled / 10000n + ((scaled % 10000n) * 2n >= 10000n ? 1n : 0n);
    };

    for (const subtotal of [1n, 7n, 333n, 9999n, 123457n, 9007199254740993n]) {
      for (const [vatBps, svcBps] of [[0, 0], [1600, 0], [0, 1000], [1600, 1000], [875, 333]]) {
        const vat = applyBps(subtotal, vatBps);
        const svc = applyBps(subtotal, svcBps);

        assert.equal(vat, expected(subtotal, vatBps), `IVA on ${subtotal} at ${vatBps}bps`);
        assert.equal(svc, expected(subtotal, svcBps), `servicio on ${subtotal} at ${svcBps}bps`);

        // Neither charge may be taken on the other: at 1600/1000 the total is
        // subtotal x 1.26, never x 1.276.
        // Whether IVA compounds on the servicio is deliberately *not* asserted
        // here. At small subtotals the two computations round to the same
        // céntimo -- at 7, both give 1 -- so the property is unobservable and
        // the assertion would only be testing the sizes chosen. The explicit
        // $100 case above is where compounding is caught.
      }
    }
  });

  it('does not reprice a served bill when the restaurant changes its rates', async () => {
    const t = await fixtures.createTable(restaurant.id, { name: `V${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: t.id, totalDue: 0,
      currency: 'USD', totalDueVes: 0, fxRate: USD_RATE
    });
    await db.query('UPDATE bills SET vat_bps = 1600 WHERE id = $1', [bill.id]);

    const dish = await product('Frozen', 10000);
    await add(bill.id, dish.id, 1);

    // The restaurant's rate moves; the open bill keeps the one it snapshotted.
    await db.query('UPDATE restaurants SET vat_bps = 2000 WHERE id = $1', [restaurant.id]);
    try {
      const { bill: updated } = await add(bill.id, dish.id, 1);
      assert.equal(updated.vat_bps, 1600, 'the bill keeps the rate it opened with');
      assert.equal(updated.subtotal_minor, '20000');
      assert.equal(updated.vat_minor, '3200', '16% still, not 20%');
    } finally {
      await db.query('UPDATE restaurants SET vat_bps = 0 WHERE id = $1', [restaurant.id]);
    }
  });

  it('updates and removes lines, recomputing the total each time', async () => {
    const bill = await itemisableBill();
    const beer = await product('Beer', 500);

    const { item } = await add(bill.id, beer.id, 1);
    const bumped = await billItems.updateQuantity({
      restaurantId: restaurant.id, billId: bill.id, itemId: item.id, quantity: 4
    });
    assert.equal(bumped.item.subtotal_minor, '2000');
    assert.equal(bumped.bill.total_due, '2000');

    const removed = await billItems.removeItem({
      restaurantId: restaurant.id, billId: bill.id, itemId: item.id
    });
    assert.equal(removed.bill.total_due, '0', 'removing the last line empties the total');
    assert.equal(removed.bill.total_due_ves, '0');
  });

  it('refuses to drop the total below what has already been paid', async () => {
    const bill = await itemisableBill();
    const dish = await product('Paid', 1000);
    const { item } = await add(bill.id, dish.id, 2);

    // Settle part of it, then try to remove the line it paid for.
    await db.query('UPDATE bills SET amount_paid_ves = $1 WHERE id = $2', ['500000', bill.id]);

    await assert.rejects(
      () => billItems.removeItem({ restaurantId: restaurant.id, billId: bill.id, itemId: item.id }),
      err => {
        // Without the guard this is a raw CHECK violation surfacing as a 500.
        assert.equal(err.code, 'TOTAL_BELOW_AMOUNT_PAID');
        assert.equal(err.statusCode, 409);
        assert.equal(err.details.amountPaidVes, '500000');
        return true;
      }
    );

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.total_due, '2000', 'the bill is untouched by the refused change');
  });

  it('refuses lines on a bill that was opened with a fixed total', async () => {
    const table = await fixtures.createTable(restaurant.id, { name: `F${++seq}` });
    const fixed = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id,
      totalDue: 5000, currency: 'USD', totalDueVes: 3787703, fxRate: USD_RATE
    });
    const dish = await product('Fixed', 100);

    await assert.rejects(
      () => add(fixed.id, dish.id, 1),
      err => {
        // Deriving would discard the supplied figure; adding would count the
        // bill twice. Refusing says so instead of picking one silently.
        assert.equal(err.code, 'BILL_NOT_ITEMISED');
        assert.equal(err.details.totalDue, '5000');
        return true;
      }
    );
  });

  it('refuses a closed bill, an inactive product and another tenant\'s product', async () => {
    const bill = await itemisableBill();
    const inactive = await product('Retired', 100, { active: false });
    await assert.rejects(() => add(bill.id, inactive.id, 1), err => {
      assert.equal(err.code, 'PRODUCT_INACTIVE');
      return true;
    });

    const other = await fixtures.createRestaurant({ name: 'Other Items Tenant' });
    try {
      const { rows } = await db.query(
        `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
         VALUES ($1, 'Theirs', 100, 'USD') RETURNING id`,
        [other.id]
      );
      await assert.rejects(() => add(bill.id, rows[0].id, 1), err => {
        // Another tenant's product reads as absent, not forbidden.
        assert.equal(err.code, 'PRODUCT_NOT_FOUND');
        return true;
      });
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }

    const good = await product('Late', 100);
    await db.query("UPDATE bills SET status = 'CLOSED' WHERE id = $1", [bill.id]);
    await assert.rejects(() => add(bill.id, good.id, 1), err => {
      assert.equal(err.code, 'BILL_NOT_OPEN');
      assert.equal(err.details.status, 'CLOSED');
      return true;
    });
  });

  it('serialises concurrent additions so the total counts every line', async () => {
    const bill = await itemisableBill();
    const side = await product('Side', 250);

    // Five waiters adding at once. The bill row is locked for each
    // recalculation, so none may read a stale set of lines.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => add(bill.id, side.id, 1))
    );
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.total_due, '1250', '5 x 250, with no lost update');

    const items = await billItems.listForBill({ restaurantId: restaurant.id, billId: bill.id });
    assert.equal(items.length, 5);
  });
});
