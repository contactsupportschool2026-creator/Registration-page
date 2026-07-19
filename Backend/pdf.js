/**
 * pdf.js — Generate a student database export PDF as an in-memory Buffer.
 *
 * Uses pdfkit (installed on Railway via npm install).
 * Tries common system font paths that support Arabic/Unicode text (DejaVu, Ubuntu, etc.).
 * Falls back to built-in Helvetica if none are found — Latin labels still render
 * correctly; Arabic field values rely on viewer font substitution.
 *
 * Usage:
 *   const { generateStudentsPDF } = require('./pdf');
 *   const buf = await generateStudentsPDF(students);
 *   // buf is a Buffer — pass to bot.sendDocument()
 */

const PDFDocument = require('pdfkit');
const fs          = require('fs');

// ── Arabic/Unicode font discovery ─────────────────────────────────────────────
// These TTF files ship with common Linux distributions (including Railway's Ubuntu).
// DejaVu and Ubuntu fonts cover Arabic, Cyrillic, Greek, and more.
const UNICODE_FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

function findFont(preferBold = false) {
    const candidates = preferBold
        ? UNICODE_FONT_CANDIDATES.filter(p => /bold/i.test(p))
        : UNICODE_FONT_CANDIDATES.filter(p => !/bold/i.test(p));

    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    // Fallback: any candidate regardless of bold preference
    for (const p of UNICODE_FONT_CANDIDATES) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null; // use pdfkit built-in Helvetica
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeText(value) {
    if (value === null || value === undefined) return 'N/A';
    return String(value);
}

function formatDate(iso) {
    if (!iso) return 'N/A';
    return iso.split('T')[0];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a PDF listing all students and return it as a Buffer.
 * @param {Array} students  Array of student objects from the database.
 * @returns {Promise<Buffer>}
 */
function generateStudentsPDF(students) {
    return new Promise((resolve, reject) => {
        const regularFont = findFont(false);
        const boldFont    = findFont(true);

        const docOptions = { margin: 45, size: 'A4' };
        // Only pass font option if we found a file — otherwise let pdfkit use Helvetica
        if (regularFont) docOptions.font = regularFont;

        const doc    = new PDFDocument(docOptions);
        const chunks = [];

        doc.on('data',  chunk => chunks.push(chunk));
        doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
        doc.on('error', err   => reject(err));

        const MARGIN    = 45;
        const PAGE_W    = doc.page.width  - MARGIN * 2;
        const PAGE_H    = doc.page.height - MARGIN * 2;
        const LABEL_W   = 115;
        const VALUE_X   = MARGIN + LABEL_W + 8;
        const VALUE_W   = PAGE_W - LABEL_W - 8;

        const now        = new Date();
        const exportDate = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

        // Helper: set bold
        const bold = () => boldFont
            ? doc.font(boldFont)
            : doc.font('Helvetica-Bold');

        // Helper: set regular
        const regular = () => regularFont
            ? doc.font(regularFont)
            : doc.font('Helvetica');

        // Helper: horizontal rule
        const rule = (color = '#cccccc', width = 0.5) => {
            doc.moveTo(MARGIN, doc.y)
               .lineTo(MARGIN + PAGE_W, doc.y)
               .lineWidth(width)
               .strokeColor(color)
               .stroke()
               .strokeColor('#000000');
        };

        // Helper: one label + value row (handles long values wrapping)
        const row = (label, value) => {
            const y = doc.y;
            bold().fontSize(9).fillColor('#555555')
                  .text(label + ':', MARGIN, y, { width: LABEL_W, lineBreak: false });
            regular().fontSize(9).fillColor('#111111')
                     .text(safeText(value), VALUE_X, y, { width: VALUE_W });
            doc.moveDown(0.15);
        };

        // ── Page header ──────────────────────────────────────────────────────
        bold().fontSize(18).fillColor('#111111')
              .text('Student Database Export', MARGIN, MARGIN, { align: 'center', width: PAGE_W });
        doc.moveDown(0.4);

        regular().fontSize(10).fillColor('#666666')
                 .text(`Generated: ${exportDate}`, { align: 'center' });
        doc.text(`Total students: ${students.length}`, { align: 'center' });
        doc.fillColor('#111111').moveDown(0.8);

        rule('#333333', 1.5);
        doc.moveDown(0.8);

        // ── Student blocks ───────────────────────────────────────────────────
        students.forEach((s, i) => {
            const renewals = s.renewalCount || 0;
            const months   = renewals === 1 ? '1 month' : `${renewals} months`;
            const nizami   = s.isNizami ? 'Nizami / نظامي' : 'Free / حر';

            // Page-break guard: ~180pt needed for one student block
            if (doc.y > doc.page.height - MARGIN - 180) {
                doc.addPage();
                doc.y = MARGIN;
            }

            // Student number + name heading
            bold().fontSize(12).fillColor('#000000')
                  .text(`${i + 1}. ${safeText(s.firstName)} ${safeText(s.lastName)}`, MARGIN, doc.y);
            doc.moveDown(0.35);

            // Personal info
            row('Invoice ID',    s.invoiceId);
            row('Email',         s.email);
            row('Date of Birth', s.dob);
            row('Wilaya',        s.wilaya);
            row('Specialty',     s.shaba);
            row('School Type',   nizami);
            row('School Name',   s.schoolName);

            doc.moveDown(0.1);

            // Payment info
            row('Status',        s.status);
            row('Months Paid',   months);
            row('Sub. Start',    formatDate(s.subscriptionStartDate));
            row('Sub. Expiry',   formatDate(s.subscriptionEndDate));

            doc.moveDown(0.1);

            // Telegram
            row('Telegram ID',   s.chatId || 'Not linked');

            doc.moveDown(0.5);

            // Divider (skip after last student)
            if (i < students.length - 1) {
                rule('#cccccc', 0.5);
                doc.moveDown(0.6);
            }
        });

        doc.end();
    });
}

module.exports = { generateStudentsPDF };
