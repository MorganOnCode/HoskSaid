-- Enable pgvector extension
create extension if not exists vector;

-- Table to store transcript chunks and their embeddings
create table if not exists transcript_chunks (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references videos(id) on delete cascade,
  content text not null,
  start_time integer, -- start time in seconds (optional, derived from segments)
  end_time integer,   -- end time in seconds
  embedding vector(1536), -- OpenAI text-embedding-3-small has 1536 dimensions
  created_at timestamptz default now()
);

-- Index for faster vector similarity search
-- lists = 100 is a good default for < 100k rows
create index on transcript_chunks using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- Function to search for similar chunks
create or replace function match_transcript_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  video_id uuid,
  content text,
  start_time integer,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    transcript_chunks.id,
    transcript_chunks.video_id,
    transcript_chunks.content,
    transcript_chunks.start_time,
    1 - (transcript_chunks.embedding <=> query_embedding) as similarity
  from transcript_chunks
  where 1 - (transcript_chunks.embedding <=> query_embedding) > match_threshold
  order by transcript_chunks.embedding <=> query_embedding
  limit match_count;
end;
$$;
