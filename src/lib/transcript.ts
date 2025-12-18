import { YoutubeTranscript } from '@danielxceron/youtube-transcript';

export interface TranscriptSegment {
    text: string;
    offset: number; // in milliseconds
    duration: number; // in milliseconds
}

export interface TranscriptResult {
    text: string;
    segments: TranscriptSegment[];
    source: 'youtube_captions' | 'extractor' | 'whisper';
}

/**
 * Fetch transcript for a YouTube video
 * Uses youtube-transcript package which extracts from YouTube's caption system
 */
export async function fetchTranscript(videoId: string): Promise<TranscriptResult | null> {
    try {
        const segments = await YoutubeTranscript.fetchTranscript(videoId);

        if (!segments || segments.length === 0) {
            return null;
        }

        // Convert to our format
        const transcriptSegments: TranscriptSegment[] = segments.map((seg) => ({
            text: seg.text,
            offset: Math.round(seg.offset),
            duration: Math.round(seg.duration),
        }));

        // Combine all segments into full text
        const fullText = transcriptSegments.map((s) => s.text).join(' ');

        return {
            text: fullText,
            segments: transcriptSegments,
            source: 'extractor',
        };
    } catch (error) {
        console.error(`Failed to fetch transcript for ${videoId}:`, error);
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

