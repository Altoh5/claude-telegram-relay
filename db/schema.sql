-- ============================================================
-- Telegram Bot - Supabase Schema
-- ============================================================
-- Run this in your Supabase SQL editor to set up the database.
-- Supabase Dashboard → SQL Editor → New Query → Paste & Run
--
-- IMPORTANT: This script is SAFE for existing databases.
-- All statements use IF NOT EXISTS — they will NOT drop or
-- overwrite existing tables or data. If you have an existing
-- Supabase project, only missing tables will be created.
--
-- DO NOT manually drop tables to "fix" schema conflicts.
-- If you have existing data you want to keep, create a
-- separate Supabase project for the bot instead.
-- ============================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  chat_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding VECTOR(1536)  -- For semantic search via OpenAI embeddings
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages (role);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel);

-- ============================================================
-- MEMORY TABLE (Facts & Goals)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory (type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory (created_at DESC);

-- ============================================================
-- LOGS TABLE (Observability)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  session_id TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_event ON logs (event);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);

-- ============================================================
-- CALL TRANSCRIPTS TABLE (Voice call history)
-- ============================================================
CREATE TABLE IF NOT EXISTS call_transcripts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  conversation_id TEXT UNIQUE NOT NULL,
  transcript TEXT,
  summary TEXT,
  action_items TEXT[] DEFAULT '{}',
  duration_seconds INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- ASYNC TASKS TABLE (Human-in-the-loop)
-- ============================================================
-- Used when Claude pauses to ask the user a question via inline buttons.
CREATE TABLE IF NOT EXISTS async_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  chat_id TEXT NOT NULL,
  original_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'needs_input', 'completed', 'failed')),
  result TEXT,
  session_id TEXT,
  current_step TEXT,
  pending_question TEXT,
  pending_options JSONB,        -- [{label, value}]
  user_response TEXT,
  thread_id INTEGER,
  processed_by TEXT,            -- 'vps', 'local', etc.
  reminder_sent BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb  -- messages_snapshot, assistant_content, tool_use_id
);

CREATE INDEX IF NOT EXISTS idx_async_tasks_chat_id ON async_tasks (chat_id);
CREATE INDEX IF NOT EXISTS idx_async_tasks_status ON async_tasks (status);
CREATE INDEX IF NOT EXISTS idx_async_tasks_updated_at ON async_tasks (updated_at DESC);

-- ============================================================
-- NODE HEARTBEAT TABLE (Hybrid mode health tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS node_heartbeat (
  node_id TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- ASSETS TABLE (Persistent image/file storage with AI descriptions)
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  storage_path TEXT NOT NULL,
  public_url TEXT,
  original_filename TEXT,
  file_type TEXT NOT NULL,  -- 'image', 'document', 'audio'
  mime_type TEXT,
  file_size_bytes INTEGER,
  description TEXT NOT NULL,
  user_caption TEXT,
  conversation_context TEXT,
  related_project TEXT,
  tags TEXT[] DEFAULT '{}',
  channel TEXT DEFAULT 'telegram',
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_assets_file_type ON assets (file_type);
CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets (created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE async_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

-- Service role full access (bot uses service role key)
CREATE POLICY "Service role full access" ON messages
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON memory
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON logs
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON call_transcripts
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON async_tasks
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON node_heartbeat
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON assets
  FOR ALL USING (auth.role() = 'service_role');

-- Anon key read access (for the bot when using anon key, or dashboards)
CREATE POLICY "Anon read access" ON messages
  FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon read access" ON memory
  FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon read access" ON assets
  FOR SELECT USING (auth.role() = 'anon');

-- Anon key insert access (for the bot when using anon key)
CREATE POLICY "Anon insert access" ON messages
  FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon insert access" ON memory
  FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon insert access" ON logs
  FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon insert access" ON async_tasks
  FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon update access" ON async_tasks
  FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon insert access" ON node_heartbeat
  FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon update access" ON node_heartbeat
  FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon insert access" ON assets
  FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get recent messages for context
CREATE OR REPLACE FUNCTION get_recent_messages(limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get active goals
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all facts
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEMANTIC SEARCH FUNCTIONS
-- ============================================================

-- Match messages by embedding similarity
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  filter_chat_id TEXT DEFAULT NULL,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  chat_id TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.chat_id,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Match memory entries by embedding similarity
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match assets by embedding similarity
CREATE OR REPLACE FUNCTION match_assets(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  description TEXT,
  tags TEXT[],
  file_type TEXT,
  public_url TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.description,
    a.tags,
    a.file_type,
    a.public_url,
    a.created_at,
    1 - (a.embedding <=> query_embedding) AS similarity
  FROM assets a
  WHERE a.embedding IS NOT NULL
    AND 1 - (a.embedding <=> query_embedding) > match_threshold
  ORDER BY a.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- MIGRATION NOTES
-- ============================================================
-- If upgrading from the free mini-course version:
-- 1. This script is safe to re-run (all IF NOT EXISTS)
-- 2. New tables (async_tasks, node_heartbeat, call_transcripts, assets) will be created
-- 3. If your messages table doesn't have chat_id, run:
--    ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id TEXT DEFAULT '';
-- 4. Create a Storage bucket named "gobot-assets" in Supabase Dashboard
--    (Settings → Storage → New Bucket → Name: "gobot-assets" → Make public)
