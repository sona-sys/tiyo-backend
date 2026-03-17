-- ============================================================
-- TIYO Pay-to-Call App — PostgreSQL Schema (V19)
-- ============================================================
-- Run this once against your Supabase/PostgreSQL database.
-- Then run seed.sql to populate creator data.
-- ============================================================

-- Clean slate (drop in reverse dependency order)
DROP TABLE IF EXISTS calls CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
DROP TABLE IF EXISTS creators CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ─── USERS ──────────────────────────────────────────────

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    phone VARCHAR(20) UNIQUE NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',   -- 'user' or 'creator'
    bio TEXT,
    profile_image_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── CREATORS (extends users) ───────────────────────────
-- One-to-one with users where role = 'creator'.
-- Stores creator-specific fields that don't belong on the user table.

CREATE TABLE creators (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rate DECIMAL(10, 2) NOT NULL DEFAULT 0.00,          -- per-minute rate in INR
    languages VARCHAR(255),                              -- e.g. 'Hindi, English'
    categories TEXT[],                                   -- e.g. {'Astrology', 'Tarot'}
    image_color VARCHAR(20) DEFAULT '#BB86FC',           -- avatar background color hex
    is_online BOOLEAN DEFAULT false,
    rating DECIMAL(3, 2) DEFAULT 0.00,                   -- avg rating (0.00 – 5.00)
    total_calls INTEGER DEFAULT 0,
    total_earnings DECIMAL(10, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── WALLETS ────────────────────────────────────────────
-- Every user gets exactly one wallet.

CREATE TABLE wallets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance DECIMAL(10, 2) DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── TRANSACTIONS ───────────────────────────────────────
-- Immutable ledger of all monetary events.

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    type VARCHAR(50) NOT NULL,                           -- 'topup', 'call_debit', 'initial'
    status VARCHAR(50) DEFAULT 'success',                -- 'success', 'failed', 'abandoned', 'pending'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── CALLS ──────────────────────────────────────────────

CREATE TABLE calls (
    id SERIAL PRIMARY KEY,
    caller_id INTEGER REFERENCES users(id),
    receiver_id INTEGER REFERENCES users(id),            -- references creator's user_id
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    total_cost DECIMAL(10, 2),
    status VARCHAR(50) DEFAULT 'initiated',              -- 'initiated', 'ringing', 'connected', 'completed', 'missed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─── INDEXES ────────────────────────────────────────────

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_creators_online ON creators(is_online);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_type ON transactions(user_id, type);
CREATE INDEX idx_calls_caller ON calls(caller_id);
CREATE INDEX idx_calls_receiver ON calls(receiver_id);
