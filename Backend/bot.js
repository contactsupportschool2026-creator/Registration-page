const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const DB_PATH = path.join(__dirname, 'database.json');
const SUPPORT_TEXT = `\n\n_For any issues, contact support: @${process.env.TELEGRAM_SUPPORT_USERNAME}_`;

const getDB = () => JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
const saveDB = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

// Helper to generate a new Chargily Pay link for monthly renewals
async function createRenewalLink(student) {
    const payload = {
        amount: 2000,
        currency: 'dzd',
        description: `Renouvellement: ${student.firstName} ${student.lastName}`,
        client_name: `${student.firstName} ${student.lastName}`,
        client_email: 'student@example.com',
        back_url: `${process.env.FRONTEND_URL}/payment.html`,
        webhook_url: `${process.env.BACKEND_URL}/api/webhook/chargily`
    };
    const res = await axios.post('https://pay.chargily.com/api/v2/checkouts', payload, {
        headers: { 'Authorization': `Bearer ${process.env.CHARGILY_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });
    
    // Update DB with new invoice ID so webhook recognizes the new payment
    const db = getDB();
    const idx = db.findIndex(s => s.chatId === student.chatId);
    if (idx !== -1) {
        db[idx].invoiceId = res.data.id;
        db[idx].status = 'pending'; 
        db[idx].linkSentTimestamp = new Date().toISOString(); // Start the 20-hour countdown
        saveDB(db);
    }
    return res.data.checkout_url;
}

// ==========================================
// FEATURE 1: STUDENT REGISTERS THEIR TELEGRAM ID
// ==========================================
bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const invoiceId = match[1];
    const db = getDB();
    const student = db.find(s => s.invoiceId === invoiceId);

    if (student) {
        student.chatId = chatId;
        saveDB(db);
        bot.sendMessage(chatId, `✅ Welcome ${student.firstName}! Your Telegram account is now linked to our system.${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `❌ Invoice ID not recognized. Make sure you clicked the correct link after payment.${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
    }
});

// ==========================================
// FEATURE 2: ADMIN COMMAND - EXTEND SUBSCRIPTION
// ==========================================
// Admin sends in private chat: /extend STUDENT_CHAT_ID NUMBER_OF_DAYS
bot.onText(/\/extend (.+) (.+)/, async (msg, match) => {
    const adminChatId = msg.chat.id;
    
    // Security: Only allow you (the admin) to use this command
    if (adminChatId.toString() !== process.env.TELEGRAM_CHAT_ID) {
        return bot.sendMessage(adminChatId, "⛔ Unauthorized.");
    }

    const targetChatId = match[1];
    const daysToAdd = parseInt(match[2]);
    const db = getDB();
    const student = db.find(s => s.chatId.toString() === targetChatId);

    if (student && student.subscriptionEndDate) {
        const newDate = new Date(student.subscriptionEndDate);
        newDate.setDate(newDate.getDate() + daysToAdd);
        student.subscriptionEndDate = newDate.toISOString();
        student.status = 'paid'; // Reset status so they aren't kicked
        student.warnedTimestamp = null;
        student.linkSentTimestamp = null;
        saveDB(db);

        // Notify Student
        const msgText = `📅 *Subscription Updated!\n\n*Your monthly renewal date has been adjusted by the admin. Your new due date is: ${newDate.toISOString().split('T')[0]}.${SUPPORT_TEXT}`;
        bot.sendMessage(student.chatId, msgText, { parse_mode: 'Markdown' });

        // Confirm to Admin
        bot.sendMessage(adminChatId, `✅ Extended subscription for ${student.firstName} by ${daysToAdd} days.`);
    } else {
        bot.sendMessage(adminChatId, "❌ Student not found or has no active subscription.");
    }
});

// ==========================================
// FEATURE 3: DAILY 8:00 AM CRON JOB (Reminders & Due Links)
// ==========================================
cron.schedule('0 8 * * *', async () => {
    console.log("Running 8:00 AM subscription check...");
    const db = getDB();
    const now = new Date();

    for (let student of db) {
        if (!student.subscriptionEndDate || !student.chatId) continue;
        if (student.status === 'kicked') continue; // Ignore kicked users

        const endDate = new Date(student.subscriptionEndDate);
        const diffTime = endDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // 1. PRE-SUBSCRIPTION REMINDER (5 to 6 days before)
        if (diffDays <= 6 && diffDays >= 5 && student.status === 'paid') {
            bot.sendMessage(student.chatId, `⏳ *Reminder!\n\n*Your subscription expires in ${diffDays} days. Please prepare for the next payment.${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
        }

        // 2. PAYMENT LINK DELIVERY (Exact due day or past due, but not yet sent)
        if (diffDays <= 0 && student.status === 'paid') {
            try {
                const checkoutUrl = await createRenewalLink(student);
                bot.sendMessage(student.chatId, `💰 *Payment Due Today!\n\n*Your monthly subscription has ended. Please click the link below to renew your access:\n\n${checkoutUrl}${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(`Failed to send link to ${student.firstName}`, err);
            }
        }
    }
}, {
    timezone: "Africa/Algiers"
});

// ==========================================
// FEATURE 4: NON-PAYMENT ENFORCEMENT (Runs every hour)
// ==========================================
cron.schedule('0 * * * *', async () => {
    console.log("Running hourly check for warnings and kicks...");
    const db = getDB();
    const now = new Date();

    for (let student of db) {
        if (!student.chatId) continue;

        // CHECK 1: 20 hours passed since link was sent -> Send Final Warning
        if (student.status === 'pending' && student.linkSentTimestamp) {
            const linkSentTime = new Date(student.linkSentTimestamp);
            const hoursPassedLink = (now - linkSentTime) / (1000 * 60 * 60);

            if (hoursPassedLink >= 20 && !student.warnedTimestamp) {
                student.status = 'warned';
                student.warnedTimestamp = now.toISOString();
                saveDB(db);
                bot.sendMessage(student.chatId, `🚨 *FINAL WARNING!\n\n*Your payment is severely overdue. You have exactly 4 hours to complete your payment before you are automatically removed from the group.${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
            }
        }

        // CHECK 2: 4 hours passed since final warning -> KICK FROM GROUP
        if (student.status === 'warned' && student.warnedTimestamp) {
            const warnedTime = new Date(student.warnedTimestamp);
            const hoursPassedWarning = (now - warnedTime) / (1000 * 60 * 60);

            if (hoursPassedWarning >= 4) {
                // Double check they haven't paid (webhook updates status back to 'paid')
                if (student.status === 'warned') {
                    try {
                        // BOT MUST BE AN ADMIN IN THE GROUP FOR THIS TO WORK
                        await bot.banChatMember(process.env.TELEGRAM_GROUP_CHAT_ID, student.chatId);
                        bot.sendMessage(student.chatId, `❌ *Access Removed\n\n*You did not complete the payment within the allotted time. You have been removed from the group. Contact support if this is a mistake.${SUPPORT_TEXT}`, { parse_mode: 'Markdown' });
                        
                        student.status = 'kicked';
                        saveDB(db);
                    } catch (err) {
                        console.error(`Failed to kick ${student.chatId}. Is the bot an admin in the group? Error:`, err.message);
                    }
                }
            }
        }
    }
}, {
    timezone: "Africa/Algiers"
});

console.log("Telegram Bot is running...");
