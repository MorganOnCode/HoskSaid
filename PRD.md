
# Product Requirements Document (PRD)

## YouTube Transcript Library & Research Engine
reviewed:: [[2025-12-18]]
updated:: [[2025-12-07]] 

## 1. Introduction

Across YouTube, creators such as Charles Hoskinson publish years of livestreams, AMAs, and commentary. These videos contain valuable insights, but the content is difficult to search, reference, or analyse. Existing transcripts are scattered, incomplete, or inaccessible.

This product creates a public research library of YouTube creator transcripts — automatically ingesting videos, generating clean transcripts, summaries, and tags, and publishing SEO-friendly pages for each video. The long-term vision is a reliable knowledge and discovery tool where users can trace ideas, compare statements over time, and explore themes across an entire creator’s catalogue.

---
## 2. Objectives & Goals
- Build an automated pipeline that ingests new YouTube videos (including livestream VODs), extracts transcripts, cleans the text, and stores them reliably.
- Publish a simple public website containing:
    - One page per video
    - Video embed + transcript + tags + summary
    - Searchable content across all videos
- Enable users to research, quote, and navigate historical content quickly.
- Provide the foundation for future semantic search, RAG, and timeline analysis tools.

---
## 3. Target Users & Roles
### End Users (public)
- Fans, researchers, journalists, token holders, and community members.
- Typical actions:
    - Browse videos, read transcripts.
    - Search for topics, phrases, or ideas.
    - Copy/share sections of transcripts.
    - Report transcript errors.
### Admin (you)
- Configure which channels/playlists to ingest.
- Trigger historical backfills.
- Review failed ingestions or flagged errors.
- Manually approve or correct transcripts when needed.
No other user roles required for MVP.

---
## 4. Core Features for MVP
### A. Automated Ingestion
- Monitor a YouTube channel for new uploads + livestream VODs.
- Fetch metadata: title, description, publish date, thumbnails, duration.
- Fetch transcript using:
    1. YouTube captions if available
    2. Transcript extractor fallback
    3. STT audio → text as a last resort
### B. Transcript Processing
- Store both raw and cleaned transcript.
- LLM steps:
    - Clean grammar and readability.
    - Create concise bullet-point summary.
    - Generate 5–10 keywords/tags.
    - Optional: generate timestamp-aligned sections.
### C. Database + API Layer
- Store channels, videos, transcripts, summaries, tags.
- Provide API endpoints for:
    - `/videos`
    - `/videos/{id}`
    - `/search?q=`
### D. Public Website
- Static/SSR site with:
    - Homepage with search + latest videos.
    - Video page layout:
        - YouTube embed
        - Summary
        - Transcript
        - Tags
        - Share link
        - Error reporting
- Simple keyword search across titles + transcripts.
### E. Automation Layer
- Scheduled workflow (e.g., every 30–60 minutes):
    - Check channel for new videos.
    - Pull transcript + metadata.
    - Push to database.
    - Rebuild/revalidate website.

---
## 5. Future Scope
- Semantic search / vector search  
    (Ask natural-language questions, retrieve quotes + timestamps.)
- RAG assistant  
    (“Ask Charles” style interactive chatbot.)
- Topic timelines  
    (E.g., “mentions of governance” plotted across years.)
- Cross-creator comparisons  
    (Multiple channels ingested → multi-speaker research engine.)
- Advanced filters
    - Themes
    - Sentiment
    - Chronological clusters
- Mobile-optimised transcript reader  
    With jump-to-timestamp behaviour.
- Creator dashboard  
    If creators want to upload/approve transcripts directly.

---
## 6. User Journey
### Visitor Journey (Public)
1. User searches on Google or your site for a topic (“ADA governance”, “midnight launch”, etc.).
2. Arrives on Search Results page showing matching videos with snippets.
3. Clicks a result → Video Page:
    - Sees video embed.
    - Reads summary.
    - Scrolls transcript (clean, readable).
    - Copies quotes or shares page link.
4. Optionally submits an error report (typo, incorrect segment, etc.).
### Admin Journey (You)
1. Add a YouTube channel or playlist ID in a small config table.
2. Run backfill ingestion to populate all historical videos.
3. Automation polls for new videos every N minutes.
4. Review ingestion logs:
    - Check for missing transcripts.
    - Re-run pipeline or manually correct text.
5. Publish updates by triggering a site rebuild or allowing ISR to refresh pages.

---
## 7. Tech Stack
### Frontend / Website
- Next.js
- React + TailwindCSS
- Vercel deployment
- ISR or API-based page revalidation.
### Backend / DB
- Supabase (Postgres) for structured storage:
    - channels
    - videos
    - transcripts
    - summaries
    - tags
- Optional: pgvector for future semantic search.
### Automation
- n8n or Make.com workflow:
    - Fetch new videos
    - Fetch transcripts
    - LLM clean-up + summary
    - Push to DB
    - Trigger site revalidation
- Optional: Apify or Firecrawl for robust transcript extraction fallback.
### LLM / NLP
- OpenAI (or other) for:
    - Cleaning transcripts
    - Summaries
    - Tags
- Whisper / AssemblyAI / Deepgram only if audio must be transcribed.
### YouTube Integration
- YouTube Data API v3
    - List videos
    - Retrieve metadata
    - Attempt caption retrieval

---