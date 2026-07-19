/**
 * db.js — Shared database helpers for server.js and bot.js
 *
 * Cross-process safety strategy:
 *  1. LOCK  — acquire an exclusive .lock file before any read-modify-write cycle.
 *             Uses the atomic 'wx' flag (create-or-fail) so only one process
 *             enters the critical section at a time.
 *  2. WRITE — write to a .tmp file first, then atomically rename it to the real
 *             path, so a crash mid-write never leaves a partial/corrupt file.
 *  3. READ  — reads that don't need to modify the DB acquire the lock briefly
 *             so they always see a fully-committed write.
 */

const fs   = require('fs');
const path = require('path');

const DB_PATH   = path.join(__dirname, 'database.json');
const LOCK_PATH = DB_PATH + '.lock';
const TMP_PATH  = DB_PATH + '.tmp';

// ─── Lock helpers ─────────────────────────────────────────────────────────────

/**
 * Try to acquire the lock file.
 * Retries up to `maxRetries` times, waiting `retryDelay` ms between attempts.
 * Throws if the lock cannot be acquired in time.
 */
async function acquireLock(maxRetries = 30, retryDelay = 100) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // 'wx' = exclusive create: fails with EEXIST if the file is already there
            fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
            return; // lock acquired
        } catch (e) {
            if (e.code !== 'EEXIST') throw e; // unexpected error
            // Another process holds the lock — wait and retry
            await new Promise(r => setTimeout(r, retryDelay));
        }
    }
    throw new Error(`Could not acquire DB lock after ${maxRetries} retries (~${(maxRetries * retryDelay) / 1000}s)`);
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone */ }
}

// ─── Initialise ───────────────────────────────────────────────────────────────

function initializeDB() {
    if (!fs.existsSync(DB_PATH)) {
        console.log('📁 database.json not found. Creating new database...');
        fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
        console.log('✅ Database initialized successfully');
    }
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Read the database without modifying it.
 * Acquires the lock so the read always sees a fully-committed state.
 *
 * @returns {Promise<Array>} Parsed database array.
 */
async function readDB() {
    await acquireLock();
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } finally {
        releaseLock();
    }
}

/**
 * Read-modify-write helper.
 * Acquires the lock, reads the DB, calls `fn(db)` so you can mutate the array,
 * then atomically writes the result back.
 *
 * Usage:
 *   const result = await withDB(db => {
 *       const student = db.find(s => s.invoiceId === id);
 *       if (student) student.status = 'paid';
 *       return student; // optional return value
 *   });
 *
 * @param {function(Array): any} fn  Synchronous or async mutator.
 * @returns {Promise<any>} Whatever `fn` returns.
 */
async function withDB(fn) {
    await acquireLock();
    try {
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        const result = await fn(db); // fn may mutate db in place

        // Atomic write: write to .tmp first, then rename
        fs.writeFileSync(TMP_PATH, JSON.stringify(db, null, 2));
        fs.renameSync(TMP_PATH, DB_PATH);

        return result;
    } finally {
        releaseLock();
    }
}

module.exports = { initializeDB, readDB, withDB };
