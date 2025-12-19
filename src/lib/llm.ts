import OpenAI from 'openai';

let openaiClient: OpenAI | null = null;

export function getClient(): OpenAI {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is not set');
        }
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}

/**
 * Clean and format a raw transcript
 * Fixes grammar, punctuation, and formats into readable paragraphs
 */
export async function cleanTranscript(rawText: string): Promise<string> {
    const client = getClient();

    // Split into chunks if the text is too long (roughly 10k tokens per chunk)
    const maxChunkLength = 30000; // characters
    const chunks: string[] = [];

    if (rawText.length > maxChunkLength) {
        // Split at sentence boundaries
        const sentences = rawText.match(/[^.!?]+[.!?]+/g) || [rawText];
        let currentChunk = '';

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length > maxChunkLength) {
                chunks.push(currentChunk);
                currentChunk = sentence;
            } else {
                currentChunk += sentence;
            }
        }
        if (currentChunk) chunks.push(currentChunk);
    } else {
        chunks.push(rawText);
    }

    const cleanedChunks: string[] = [];

    for (const chunk of chunks) {
        const response = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a transcript editor. Clean up the following transcript text:
- Fix grammar and punctuation
- Remove filler words (um, uh, like, you know) when excessive
- Format into readable paragraphs
- Preserve the original meaning and speaker's voice
- Do NOT add content that wasn't in the original
- Do NOT remove substantive content
- Keep technical terms and names exactly as spoken

Return only the cleaned transcript, no explanations.`,
                },
                {
                    role: 'user',
                    content: chunk,
                },
            ],
            temperature: 0.3,
            max_tokens: 4000,
        });

        cleanedChunks.push(response.choices[0].message.content || chunk);
    }

    return cleanedChunks.join('\n\n');
}

/**
 * Generate a concise bullet-point summary of the transcript
 */
export async function generateSummary(text: string): Promise<string> {
    const client = getClient();

    // Truncate if too long
    const maxLength = 50000;
    const truncatedText = text.length > maxLength ? text.slice(0, maxLength) + '...' : text;

    const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a content summarizer. Create a concise bullet-point summary of this video transcript.

Guidelines:
- Use 5-10 bullet points
- Focus on key topics, announcements, and insights
- Include any specific names, projects, or technical terms mentioned
- Be factual and objective
- Format each bullet point on its own line starting with "• "

Return only the bullet points, no introduction or conclusion.`,
            },
            {
                role: 'user',
                content: truncatedText,
            },
        ],
        temperature: 0.3,
        max_tokens: 1000,
    });

    return response.choices[0].message.content || '';
}

/**
 * Generate 5-10 relevant tags for the content
 */
export async function generateTags(text: string): Promise<string[]> {
    const client = getClient();

    // Truncate if too long
    const maxLength = 30000;
    const truncatedText = text.length > maxLength ? text.slice(0, maxLength) + '...' : text;

    const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a content tagger. Generate 5-10 relevant tags for this video transcript.

Guidelines:
- Tags should be lowercase, single words or short phrases
- Include topic categories (e.g., "governance", "development", "community")
- Include specific project/technology names mentioned
- Include relevant themes
- Return as a JSON array of strings

Example output: ["cardano", "governance", "voltaire", "smart contracts", "development update"]`,
            },
            {
                role: 'user',
                content: truncatedText,
            },
        ],
        temperature: 0.3,
        max_tokens: 200,
        response_format: { type: 'json_object' },
    });

    try {
        const content = response.choices[0].message.content || '{"tags": []}';
        const parsed = JSON.parse(content);
        return Array.isArray(parsed.tags) ? parsed.tags : [];
    } catch {
        console.error('Failed to parse tags response');
        return [];
    }
}

/**
 * Process a transcript through the full LLM pipeline
 */
export async function processTranscript(rawText: string): Promise<{
    cleanedText: string;
    summary: string;
    tags: string[];
}> {
    // Run cleaning first (summary and tags need cleaned text)
    const cleanedText = await cleanTranscript(rawText);

    // Run summary and tags in parallel
    const [summary, tags] = await Promise.all([
        generateSummary(cleanedText),
        generateTags(cleanedText),
    ]);

    return { cleanedText, summary, tags };
}

/**
 * Generate a vector embedding for the given text using OpenAI text-embedding-3-small
 * Dimensions: 1536
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const client = getClient();

    // Cleanup text to remove newlines/excess whitespace which can affect embeddings
    const cleanText = text.replace(/\n/g, ' ').trim();

    if (!cleanText) return [];

    const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: cleanText,
        dimensions: 1536
    });

    return response.data[0].embedding;
}
