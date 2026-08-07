const db = require('../connectors/base');

async function processSplitPayment(tableId, amountPaidMinorUnits) {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');

        // Row locking to prevent double-split/race conditions
        const billResult = await client.query(
            'SELECT id, total_due, amount_paid, status FROM bills WHERE table_id = $1 FOR UPDATE',
            [tableId]
        );

        if (billResult.rows.length === 0) {
            throw new Error('Active bill not found for table');
        }

        const bill = billResult.rows[0];

        if (bill.status === 'CLOSED') {
            throw new Error('Bill is already fully paid');
        }

        const newAmountPaid = parseInt(bill.amount_paid, 10) + parseInt(amountPaidMinorUnits, 10);
        let newStatus = 'OPEN';

        if (newAmountPaid >= parseInt(bill.total_due, 10)) {
            newStatus = 'CLOSED';
        }

        await client.query(
            'UPDATE bills SET amount_paid = $1, status = $2 WHERE id = $3',
            [newAmountPaid, newStatus, bill.id]
        );

        await client.query('COMMIT');
        return { 
            status: newStatus, 
            totalDue: bill.total_due,
            amountPaid: newAmountPaid,
            remaining: Math.max(0, bill.total_due - newAmountPaid)
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { processSplitPayment };
