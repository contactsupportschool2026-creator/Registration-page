const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const { initializeDB, withDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

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
function verifyChargilySignature(payload, signature) {
    const hash = crypto
        .createHmac('sha256', process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
    return hash === signature;
}

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
            warnedTimestamp: null
        };

        const chargilyPayload = {
            amount: 2000,
            currency: 'dzd',
            description: `School Registration: ${firstName} ${lastName}`,
            client_name: `${firstName} ${lastName}`,
            client_email: email,
            back_url: `${process.env.FRONTEND_URL}/payment.html`,
            webhook_url: `${process.env.BACKEND_URL}/api/webhook/chargily`
        };

        const chargilyResponse = await axios.post(
            'https://pay.chargily.com/api/v2/checkouts',
            chargilyPayload,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.CHARGILY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        studentData.invoiceId = chargilyResponse.data.id;

        // withDB acquires the cross-process lock before pushing the new student
        await withDB(db => {
            db.push(studentData);
        });

        const checkoutUrl = `${chargilyResponse.data.checkout_url}?invoice=${studentData.invoiceId}`;
        res.json({ checkoutUrl });

    } catch (error) {
        console.error('❌ Checkout Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to create payment link' });
    }
});

// ==========================================
// ENDPOINT 2: CHARGILY WEBHOOK
// ==========================================
app.post('/api/webhook/chargily', async (req, res) => {
    const signature = req.headers['x-chargily-signature'];
    const payload   = req.body;

    if (!signature) {
        console.warn('⚠️ Webhook received without signature - REJECTED');
        return res.status(401).json({ error: 'Missing signature' });
    }

    if (!verifyChargilySignature(payload, signature)) {
        console.warn('⚠️ Webhook signature mismatch - REJECTED (possible attack)');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('✅ Webhook signature verified - processing payment');

    if (payload.status === 'paid') {
        const invoiceId = payload.id;

        // In-process duplicate guard
        if (!lockInvoice(invoiceId)) {
            console.warn(`⚠️ Invoice ${invoiceId} already being processed - DUPLICATE REJECTED`);
            return res.status(200).send('OK');
        }

        try {
            let studentName = null;

            // withDB holds the cross-process file lock for the full read-modify-write
            await withDB(async db => {
                const studentIndex = db.findIndex(s => s.invoiceId === invoiceId);

                if (studentIndex !== -1 && db[studentIndex].status === 'pending') {
                    const now        = new Date();
                    const expiration = new Date(now);
                    expiration.setDate(expiration.getDate() + 30);

                    db[studentIndex].status                = 'paid';
                    db[studentIndex].subscriptionStartDate = now.toISOString();
                    db[studentIndex].subscriptionEndDate   = expiration.toISOString();

                    studentName = `${db[studentIndex].firstName} ${db[studentIndex].lastName}`;

                    // Build Telegram message (inside withDB so we have the data)
                    const s          = db[studentIndex];
                    const nizamiText = s.isNizami ? 'نظامي' : 'حر';
                    const message    = `
🟢 *دفعة جديدة ناجحة!*

👤 *الإسم:* ${s.firstName} ${s.lastName}
📧 *البريد:* ${s.email}
📅 *تاريخ الميلاد:* ${s.dob}
🏙️ *الولاية:* ${s.wilaya}
📚 *الشعبة:* ${s.shaba}
🏫 *نوعية التعليم:* ${nizamiText}
🏫 *اسم الثانوية:* ${s.schoolName}

💎 *الحالة:* مدفوع (2000 دج)
                    `;
                    const supportMention = `\n\n_For any issues, contact support: @${process.env.TELEGRAM_SUPPORT_USERNAME}_`;

                    // Send Telegram notification (inside withDB — lock released only after write)
                    await axios.post(TELEGRAM_API, {
                        chat_id:    process.env.TELEGRAM_CHAT_ID,
                        text:       message + supportMention,
                        parse_mode: 'Markdown'
                    });

                } else if (studentIndex !== -1 && db[studentIndex].status === 'paid') {
                    console.warn(`⚠️ Invoice ${invoiceId} already marked as paid - DUPLICATE IGNORED`);
                } else {
                    console.warn(`❌ Invoice ${invoiceId} not found in database`);
                }
            });

            if (studentName) {
                console.log(`✅ Payment confirmed and Telegram notified for ${studentName}`);
            }

        } catch (error) {
            console.error('❌ Webhook Error:', error.message);
            // Still respond 200 so Chargily doesn't retry endlessly
        } finally {
            unlockInvoice(invoiceId);
        }
    }

    res.status(200).send('OK');
});

// ==========================================
// ENDPOINT 3: CHECK PAYMENT STATUS
// ==========================================
app.get('/api/check-payment/:invoiceId', async (req, res) => {
    try {
        // readDB acquires the lock for a consistent read
        const { readDB } = require('./db');
        const db         = await readDB();
        const student    = db.find(s => s.invoiceId === req.params.invoiceId);

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
