-- ============================================================
-- Go Telegram Bot - Supabase Schema
-- ============================================================
-- Run this in your Supabase SQL editor to set up the database.
-- Supabase Dashboard → SQL Editor → New Query → Paste & Run
-- ============================================================

-- Messages table (conversation history)
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  message_text TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'assistant')),
  user_telegram_id TEXT,
  chat_telegram_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding VECTOR(1536)  -- Optional: for semantic search via OpenAI embeddings
);

-- Memory table (facts, goals, preferences)
CREATE TABLE IF NOT EXISTS memory (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Logs table (observability)
CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  session_id TEXT,
  duration_ms INTEGER
);

-- Call transcripts table (optional: for voice call history)
CREATE TABLE IF NOT EXISTS call_transcripts (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  conversation_id TEXT UNIQUE NOT NULL,
  transcript TEXT,
  summary TEXT,
  action_items TEXT[] DEFAULT '{}',
  duration_seconds INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Messages: fast lookup by time and channel
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages ((metadata->>'channel'));
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_type);

-- Memory: fast lookup by type
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory (type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory (created_at DESC);

-- Logs: fast lookup by event and level
CREATE INDEX IF NOT EXISTS idx_logs_event ON logs (event);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY (Optional but recommended)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_transcripts ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (your bot uses service role key)
CREATE POLICY "Service role full access" ON messages
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON memory
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON logs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON call_transcripts
  FOR ALL USING (auth.role() = 'service_role');

-- Allow anon key read access (for dashboard, if you build one)
CREATE POLICY "Anon read access" ON messages
  FOR SELECT USING (auth.role() = 'anon');

CREATE POLICY "Anon read access" ON memory
  FOR SELECT USING (auth.role() = 'anon');

-- Allow anon key insert (for the bot when using anon key)
CREATE POLICY "Anon insert access" ON messages
  FOR INSERT WITH CHECK (auth.role() = 'anon');

CREATE POLICY "Anon insert access" ON memory
  FOR INSERT WITH CHECK (auth.role() = 'anon');

CREATE POLICY "Anon insert access" ON logs
  FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ============================================================
-- OPTIONAL: Semantic Search Function
-- ============================================================
-- Requires pgvector extension and embeddings stored in messages.embedding
-- Uncomment if you set up the store-telegram-message edge function

-- CREATE OR REPLACE FUNCTION match_messages(
--   query_embedding VECTOR(1536),
--   match_threshold FLOAT DEFAULT 0.7,
--   match_count INT DEFAULT 5
-- )
-- RETURNS TABLE (
--   id BIGINT,
--   message_text TEXT,
--   sender_type TEXT,
--   created_at TIMESTAMPTZ,
--   similarity FLOAT
-- )
-- LANGUAGE plpgsql
-- AS $$
-- BEGIN
--   RETURN QUERY
--   SELECT
--     m.id,
--     m.message_text,
--     m.sender_type,
--     m.created_at,
--     1 - (m.embedding <=> query_embedding) AS similarity
--   FROM messages m
--   WHERE m.embedding IS NOT NULL
--     AND 1 - (m.embedding <=> query_embedding) > match_threshold
--   ORDER BY m.embedding <=> query_embedding
--   LIMIT match_count;
-- END;
-- $$;
