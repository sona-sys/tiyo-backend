-- ============================================================
-- TIYO — Seed Data (V19)
-- ============================================================
-- Run AFTER schema.sql. Populates the 6 creators from Phase 1.
-- ============================================================

-- ─── CREATOR USERS ──────────────────────────────────────

INSERT INTO users (id, name, phone, role, bio) VALUES
(1, 'Nida', '+creator_nida', 'creator',
 'Hi, I''m Nida! I have 5 years of experience in Vedic astrology and Tarot. Let''s explore what the stars have in store for you.'),
(2, 'Riya', '+creator_riya', 'creator',
 'Specializing in relationship counseling and toxic attachments. I provide a safe, non-judgmental space to talk through anything.'),
(3, 'Kabir', '+creator_kabir', 'creator',
 'Ex-FAANG engineer offering career advice, mock interviews, and resume reviews for aspiring tech professionals.'),
(4, 'Simran', '+creator_simran', 'creator',
 'Certified life coach here to help you unlock your maximum potential. Transform your mindset and achieve daily wins.'),
(5, 'Dr. Zoya', '+creator_zoya', 'creator',
 'Premium licensed therapist with 10+ years of clinical experience. Confidential and professional support for anxiety and stress.'),
(6, 'Vikram', '+creator_vikram', 'creator',
 'Serial entrepreneur and venture capitalist. Let''s discuss your startup pitch, fundraising strategy, and scaling operations.');

-- ─── CREATOR PROFILES ───────────────────────────────────

INSERT INTO creators (user_id, rate, languages, categories, image_color, is_online, rating, total_calls) VALUES
(1, 10.00,  'Hindi, English',   ARRAY['Astrology', 'Tarot'],    '#BB86FC', true,  4.80, 124),
(2, 15.00,  'Hindi, Punjabi',   ARRAY['Relationships'],          '#03DAC6', true,  4.90, 89),
(3, 20.00,  'English',          ARRAY['Career', 'Tech'],         '#CF6679', false, 4.60, 45),
(4, 12.00,  'Hindi',            ARRAY['Life Coach'],             '#FFA000', true,  5.00, 210),
(5, 50.00,  'English, French',  ARRAY['Therapy', 'Premium'],     '#F48FB1', true,  4.90, 450),
(6, 100.00, 'Hindi, English',   ARRAY['Business Strategy'],      '#81D4FA', false, 5.00, 80);

-- ─── CREATOR WALLETS (creators need wallets for earnings tracking) ──

INSERT INTO wallets (user_id, balance) VALUES
(1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0);

-- ─── RESET SEQUENCE ─────────────────────────────────────
-- Ensure new user IDs start after the seeded creators (id 7+)

SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));
