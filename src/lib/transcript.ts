import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface TranscriptSegment {
    text: string;
    offset: number; // in milliseconds
    duration: number; // in milliseconds
}

export interface TranscriptResult {
    text: string;
    // Timed caption cues. Persisted to transcripts.segments so generate-embeddings
    // can produce TIMED transcript_chunks (start/end seconds) for deep-links.
    segments: TranscriptSegment[];
    source: 'youtube_captions' | 'extractor' | 'whisper' | 'yt-dlp';
}

/**
 * Fetch transcript for a YouTube video.
 *
 * Primary path is yt-dlp json3 auto-subs (reliable from a residential IP and the
 * only path that preserves per-cue timing). Falls back to the youtube-transcript
 * package. The whisper audio fallback lives in the caller (ingest.ts) for the
 * caption-less videos. Both paths return TIMED segments.
 */
export async function fetchTranscript(videoId: string): Promise<TranscriptResult | null> {
    // Try yt-dlp first (most reliable, works from residential IPs, keeps timing).
    const ytdlpResult = await fetchTranscriptYtDlp(videoId);
    if (ytdlpResult) return ytdlpResult;

    // Fallback: the youtube-transcript package (still timed).
    try {
        const { YoutubeTranscript } = await import('youtube-transcript');
        const segments = await YoutubeTranscript.fetchTranscript(videoId);
        if (segments && segments.length > 0) {
            const transcriptSegments: TranscriptSegment[] = segments.map(
                (seg: { text: string; offset: number; duration: number }) => ({
                    text: seg.text,
                    offset: Math.round(seg.offset),
                    duration: Math.round(seg.duration),
                })
            );
            const fullText = transcriptSegments.map((s) => s.text).join(' ');
            return { text: fullText, segments: transcriptSegments, source: 'extractor' };
        }
    } catch (error) {
        console.error(`youtube-transcript fallback failed for ${videoId}:`, error);
    }

    return null;
}

/**
 * Extract auto-generated captions with yt-dlp.
 * Downloads only the subtitle file in json3 format (no audio/video), then parses
 * its events into timed segments {text, offset(ms), duration(ms)}.
 */
async function fetchTranscriptYtDlp(videoId: string): Promise<TranscriptResult | null> {
    const tempDir = os.tmpdir();
    const outputBase = path.join(tempDir, `hosksaid_${videoId}`);

    try {
        // Is yt-dlp available?
        try {
            execSync('yt-dlp --version', { stdio: 'ignore' });
        } catch {
            console.log(`[Transcript] yt-dlp not available, skipping`);
            return null;
        }

        console.log(`[Transcript] Fetching captions via yt-dlp for ${videoId}...`);

        // Optional browser cookies to pass YouTube's bot check (set
        // YTDLP_COOKIES_FROM_BROWSER=safari|chrome|brave|firefox in .env).
        const cookies = process.env.YTDLP_COOKIES_FROM_BROWSER
            ? ` --cookies-from-browser ${process.env.YTDLP_COOKIES_FROM_BROWSER}`
            : '';
        // YouTube's n-challenge needs the EJS solver script + a JS runtime (deno).
        const ytdlpArgs = `${cookies} --remote-components ejs:github`;

        execSync(
            `yt-dlp${ytdlpArgs} --write-auto-sub --sub-lang "en,en-orig" --sub-format json3 --skip-download --no-warnings -o "${outputBase}" "https://www.youtube.com/watch?v=${videoId}"`,
            { stdio: 'pipe', timeout: 120000 }
        );

        // Find the downloaded subtitle file.
        let subtitleFile: string | null = null;
        for (const f of [`${outputBase}.en.json3`, `${outputBase}.en-orig.json3`]) {
            if (fs.existsSync(f)) { subtitleFile = f; break; }
        }
        if (!subtitleFile) {
            const dir = path.dirname(outputBase);
            const base = path.basename(outputBase);
            const files = fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith('.json3'));
            if (files.length > 0) subtitleFile = path.join(dir, files[0]);
        }
        if (!subtitleFile) {
            console.log(`[Transcript] No subtitle file found for ${videoId}`);
            return null;
        }

        const raw = fs.readFileSync(subtitleFile, 'utf-8');
        const data = JSON.parse(raw);

        // json3 format: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
        const events = (data.events || []).filter(
            (e: { segs?: unknown[] }) => e.segs && e.segs.length > 0
        );
        const segments: TranscriptSegment[] = events
            .map((e: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }) => ({
                text: e.segs.map((s: { utf8: string }) => s.utf8 || '').join('').trim(),
                offset: e.tStartMs || 0,
                duration: e.dDurationMs || 0,
            }))
            .filter((s: TranscriptSegment) => s.text.length > 0);

        fs.unlinkSync(subtitleFile);

        if (segments.length === 0) {
            console.log(`[Transcript] Parsed 0 segments for ${videoId}`);
            return null;
        }

        const fullText = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
        console.log(`[Transcript] ✅ Got ${segments.length} segments (${fullText.length} chars) for ${videoId}`);

        return { text: fullText, segments, source: 'yt-dlp' };
    } catch (error) {
        console.error(`[Transcript] yt-dlp error for ${videoId}:`, error);
        // Clean up any partial files.
        try {
            const dir = path.dirname(outputBase);
            const base = path.basename(outputBase);
            fs.readdirSync(dir)
                .filter((f) => f.startsWith(base))
                .forEach((f) => fs.unlinkSync(path.join(dir, f)));
        } catch { /* ignore cleanup errors */ }
        return null;
    }
}

/**
 * Format transcript with timestamps for display
 */
export function formatTranscriptWithTimestamps(segments: TranscriptSegment[]): string {
    return segments
        .map((seg) => {
            const seconds = Math.floor(seg.offset / 1000);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            const timestamp = `[${minutes}:${remainingSeconds.toString().padStart(2, '0')}]`;
            return `${timestamp} ${seg.text}`;
        })
        .join('\n');
}

/**
 * Group transcript segments into paragraphs based on pauses
 */
export function groupIntoParagraphs(
    segments: TranscriptSegment[],
    pauseThreshold: number = 2000 // 2 seconds
): string[] {
    if (segments.length === 0) return [];

    const paragraphs: string[] = [];
    let currentParagraph: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        currentParagraph.push(segments[i].text);

        // Check if there's a significant pause before the next segment
        if (i < segments.length - 1) {
            const currentEnd = segments[i].offset + segments[i].duration;
            const nextStart = segments[i + 1].offset;
            const pause = nextStart - currentEnd;

            if (pause > pauseThreshold) {
                paragraphs.push(currentParagraph.join(' ').trim());
                currentParagraph = [];
            }
        }
    }

    // Add remaining text
    if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(' ').trim());
    }

    return paragraphs;
}

/**
 * Create a text snippet around a search term for display
 */
export function createSnippet(
    text: string,
    searchTerm: string,
    contextLength: number = 100
): string | null {
    const lowerText = text.toLowerCase();
    const lowerTerm = searchTerm.toLowerCase();
    const index = lowerText.indexOf(lowerTerm);

    if (index === -1) return null;

    const start = Math.max(0, index - contextLength);
    const end = Math.min(text.length, index + searchTerm.length + contextLength);

    let snippet = text.slice(start, end);

    // Add ellipsis if we're not at the boundaries
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
}

/**
 * Clean up raw transcript text for better readability
 */
export function cleanTranscriptText(
    text: string,
    options: {
        removeFillers?: boolean;
        addParagraphs?: boolean;
        sentencesPerParagraph?: number;
    } = {}
): string {
    const {
        removeFillers = true,
        addParagraphs = true,
        sentencesPerParagraph = 4,
    } = options;

    let cleaned = text;

    // Decode HTML entities (handle double-encoded entities first)
    cleaned = cleaned
        .replace(/&amp;#39;/g, "'")
        .replace(/&amp;quot;/g, '"')
        .replace(/&amp;amp;/g, '&')
        .replace(/&amp;lt;/g, '<')
        .replace(/&amp;gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');

    // Remove verbal fillers if requested
    if (removeFillers) {
        // Remove common verbal fillers (case insensitive, with word boundaries)
        cleaned = cleaned
            .replace(/\b(um|uh|er|ah)\b[,.]?\s*/gi, '')
            .replace(/\byou know[,.]?\s*/gi, '')
            .replace(/\blike\b[,.]?\s+(?=\b(um|uh|I|we|they|he|she|it|you|so|and|but|the|a|an)\b)/gi, '');
    }

    // Normalize whitespace
    cleaned = cleaned
        .replace(/\s+/g, ' ')
        .trim();

    // Add paragraph breaks if requested
    if (addParagraphs && sentencesPerParagraph > 0) {
        // Split by sentence endings
        const sentences = cleaned.match(/[^.!?]+[.!?]+\s*/g) || [cleaned];
        const paragraphs: string[] = [];

        for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
            const paragraph = sentences
                .slice(i, i + sentencesPerParagraph)
                .join('')
                .trim();
            if (paragraph) {
                paragraphs.push(paragraph);
            }
        }

        cleaned = paragraphs.join('\n\n');
    }

    return cleaned;
}

