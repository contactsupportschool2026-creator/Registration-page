const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const { initializeDB, readDB, withDB } = require('./db');
const { withRetry }                    = require('./retry');

const app = express();
app.use(cors());

// Initialize database file on startup
initializeDB();

// ==========================================
// RACE CONDITION PREVENTION: Processing Lock
// ==========================================
// In-process guard: prevents the same invoice webhook from being
// handled twice concurrently within this server process.
// Cross-process safety (vs. bot.js) is handled by db.js withDB().
const processingInvoices = new Set();

function lockInvoice(invoiceId) {
    if (processingInvoices.has(invoiceId)) return false;
    processingInvoices.add(invoiceId);
    return true;
}

function unlockInvoice(invoiceId) {
    processingInvoices.delete(invoiceId);
}

// ==========================================
// WEBHOOK SIGNATURE VERIFICATION HELPER
// ==========================================
// IMPORTANT: called with the raw request body Buffer, NOT parsed JSON.
// Re-serialising parsed JSON changes whitespace / key order and breaks the HMAC.
function verifyChargilySignature(rawBody, signature) {
    const hash = crypto
        .createHmac('sha256', process.env.CHARGILY_SECRET_KEY)
        .update(rawBody)          // raw Buffer — same bytes Chargily signed
        .digest('hex');
    return hash === signature;
}

// ==========================================
// ENDPOINT 2: CHARGILY WEBHOOK
// ==========================================
// MUST be registered BEFORE app.use(express.json()) so the route middleware
// receives the raw body buffer instead of the already-parsed object.
app.post(
    '/api/webhook/chargily',
    express.raw({ type: 'application/json' }),   // gives us req.body as Buffer
    async (req, res) => {
        const rawBody   = req.body;               // Buffer
        const signature = req.headers['signature'];

        if (!signature) {
            console.warn('⚠️ Webhook received without signature - REJECTED');
            return res.status(401).json({ error: 'Missing signature' });
        }

        if (!verifyChargilySignature(rawBody, signature)) {
            console.warn('⚠️ Webhook signature mismatch - REJECTED (possible attack)');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        console.log('✅ Webhook signature verified - processing payment');

        // Parse JSON now that signature is confirmed
        let payload;
        try {
            payload = JSON.parse(rawBody.toString('utf-8'));
        } catch (e) {
            console.error('❌ Webhook body is not valid JSON:', e.message);
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        if (payload.status === 'paid') {
            const invoiceId = payload.id;

            // In-process duplicate guard
            if (!lockInvoice(invoiceId)) {
                console.warn(`⚠️ Invoice ${invoiceId} already being processed - DUPLICATE REJECTED`);
                return res.status(200).send('OK');
            }

            try {
                // ── Step 1: update DB under the lock (no network calls here) ──────
                // withDB callback is synchronous-only; collect a snapshot of the
                // student data needed for Telegram, then do network I/O after the
                // lock is released.
                const studentSnapshot = await withDB(db => {
                    const studentIndex = db.findIndex(s => s.invoiceId === invoiceId);

                    if (studentIndex !== -1 && db[studentIndex].status === 'pending') {
                        const now        = new Date();
                        const expiration = new Date(now);
                        expiration.setDate(expiration.getDate() + 30);

                        db[studentIndex].status                = 'paid';
                        db[studentIndex].subscriptionStartDate = now.toISOString();
                        db[studentIndex].subscriptionEndDate   = expiration.toISOString();
                        // Increment for every confirmed payment (first registration + all renewals)
                        db[studentIndex].renewalCount = (db[studentIndex].renewalCount || 0) + 1;

                        // Return a plain-data snapshot — lock released after this returns
                        return { ...db[studentIndex] };

                    } else if (studentIndex !== -1 && db[studentIndex].status === 'paid') {
                        console.warn(`⚠️ Invoice ${invoiceId} already marked as paid - DUPLICATE IGNORED`);
                    } else {
                        console.warn(`❌ Invoice ${invoiceId} not found in database`);
                    }
                    return null;
                });

                // ── Step 2: network I/O after the lock is released ────────────────
                if (studentSnapshot) {
                    const s          = studentSnapshot;
                    const nizamiText = s.isNizami ? 'نظامي' : 'حر';
                    const newExpiry  = s.subscriptionEndDate
                        ? s.subscriptionEndDate.split('T')[0]
                        : 'N/A';

                    const message = `
🟢 *دفعة جديدة ناجحة!*

👤 *الإسم:* ${s.firstName} ${s.lastName}
📧 *البريد:* ${s.email}
📅 *تاريخ الميلاد:* ${s.dob}
🏙️ *الولاية:* ${s.wilaya}
📚 *الشعبة:* ${s.shaba}
🏫 *نوعية التعليم:* ${nizamiText}
🏫 *اسم الثانوية:* ${s.schoolName}

💎 *الحالة:* مدفوع (2000 دج)
📆 *الاشتراك حتى:* ${newExpiry}
🔁 *عدد التجديدات:* ${s.renewalCount}
                    `;
                    const supportMention = `\n\n_For any issues, contact support: @${process.env.TELEGRAM_SUPPORT_USERNAME}_`;

                    const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
                    await withRetry(
                        () => axios.post(TELEGRAM_API, {
                            chat_id:    process.env.TELEGRAM_CHAT_ID,
                            text:       message + supportMention,
                            parse_mode: 'Markdown'
                        }, { timeout: 10_000 }),
                        { label: 'telegram:webhook-notify' }
                    );

                    console.log(`✅ Payment confirmed and Telegram notified for ${s.firstName} ${s.lastName}`);
                }

            } catch (error) {
                console.error('❌ Webhook Error:', error.message);
                // Still respond 200 so Chargily doesn't retry endlessly
            } finally {
                unlockInvoice(invoiceId);
            }
        }

        res.status(200).send('OK');
    }
);

// Apply JSON parsing for all other routes (registered AFTER the raw-body webhook)
app.use(express.json());

// ==========================================
// ENDPOINT 1: CREATE CHARGILY CHECKOUT
// ==========================================
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { firstName, lastName, email, dob, wilaya, shaba, isNizami, schoolName } = req.body;

        const studentData = {
            firstName,
            lastName,
            email,
            dob,
            wilaya,
            shaba,
            isNizami,
            schoolName,
            status: 'pending',
            subscriptionStartDate: null,
            subscriptionEndDate: null,
            chatId: null,
            invoiceId: null,
            warnedTimestamp: null,
            linkSentTimestamp: null,
            renewalCount: 0        // incremented by 1 on every confirmed payment
        };

        const chargilyPayload = {
            amount:      2000,
            currency:    'dzd',
            description: `School Registration: ${firstName} ${lastName}`,
            client_name: `${firstName} ${lastName}`,
            client_email: email,
            // Chargily appends ?checkout_id=<id> to back_url after payment,
            // which payment.html reads to verify the payment.
            back_url:    `${process.env.FRONTEND_URL}/payment.html`,
            webhook_url: `${process.env.BACKEND_URL}/api/webhook/chargily`
        };

        const chargilyResponse = await withRetry(
            () => axios.post(
                'https://pay.chargily.net/api/v2/checkouts',
                chargilyPayload,
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.CHARGILY_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            ),
            { label: 'chargily:create-checkout' }
        );

        studentData.invoiceId = chargilyResponse.data.id;

        // withDB acquires the cross-process lock before pushing the new student
        await withDB(db => {
            db.push(studentData);
        });

        res.json({ checkoutUrl: chargilyResponse.data.checkout_url });

    } catch (error) {
        console.error('❌ Checkout Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to create payment link' });
    }
});

// ==========================================
// ENDPOINT 3: CHECK PAYMENT STATUS
// ==========================================
app.get('/api/check-payment/:invoiceId', async (req, res) => {
    try {
        const db      = await readDB();
        const student = db.find(s => s.invoiceId === req.params.invoiceId);

        if (student && student.status === 'paid') {
            res.json({
                success:   true,
                groupLink: process.env.TELEGRAM_GROUP_LINK,
                botLink:   `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${student.invoiceId}`
            });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('❌ Check Payment Error:', error.message);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
