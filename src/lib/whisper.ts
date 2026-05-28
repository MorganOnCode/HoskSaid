import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getClient } from './llm';
import { TranscriptResult, TranscriptSegment } from './transcript';

/**
 * Download audio from YouTube and transcribe it with OpenAI Whisper.
 * Fallback for when standard captions are unavailable.
 * Requires `yt-dlp` and `ffmpeg` on PATH.
 *
 * OpenAI's Whisper API caps uploads at 25MB. Long videos (multi-hour AMAs)
 * blow past that, so we always re-encode to mono 16kHz (Whisper's native
 * rate — no quality loss for speech, ~4x smaller) and split into fixed-length
 * chunks, transcribe each, and stitch the text + timestamps back together.
 */

const WHISPER_LIMIT_MB = 24;   // API hard cap is 25MB; stay under it.
const CHUNK_SECONDS = 600;     // 10-min mono 16kHz @48k ≈ 3.6MB/chunk.

export async function transcribeWithWhisper(videoId: string): Promise<TranscriptResult | null> {
    const tempDir = os.tmpdir();
    const base = path.join(tempDir, `hosksaid_${videoId}`);
    const sourceMp3 = `${base}.mp3`;
    const chunkPrefix = `hosksaid_${videoId}_chunk_`;
    const createdChunks: string[] = [];

    const cleanup = () => {
        for (const f of createdChunks) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* ignore */ } }
        try { fs.existsSync(sourceMp3) && fs.unlinkSync(sourceMp3); } catch { /* ignore */ }
    };

    console.log(`🎙️ [Whisper] Downloading audio for ${videoId}...`);

    try {
        // Tool checks.
        try { execSync('yt-dlp --version', { stdio: 'ignore' }); }
        catch { console.error('❌ yt-dlp is not installed or not found in PATH.'); return null; }
        try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
        catch { console.error('❌ ffmpeg is not installed or not found in PATH.'); return null; }

        // Download + extract audio to mp3.
        execSync(
            `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${base}.%(ext)s" https://www.youtube.com/watch?v=${videoId}`,
            { stdio: 'inherit' }
        );
        if (!fs.existsSync(sourceMp3)) {
            console.error(`❌ Failed to find downloaded audio file: ${sourceMp3}`);
            return null;
        }
        const sizeMB = fs.statSync(sourceMp3).size / (1024 * 1024);
        console.log(`🎙️ [Whisper] Audio downloaded (${sizeMB.toFixed(2)} MB). Re-encoding + chunking...`);

        // Re-encode to mono 16kHz @48k and split into CHUNK_SECONDS segments.
        // One ffmpeg pass does both; output files are base_chunk_000.mp3, etc.
        execSync(
            `ffmpeg -hide_banner -loglevel error -i "${sourceMp3}" ` +
            `-ac 1 -ar 16000 -c:a libmp3lame -b:a 48k ` +
            `-f segment -segment_time ${CHUNK_SECONDS} "${base}_chunk_%03d.mp3"`,
            { stdio: 'inherit' }
        );

        // Collect the chunk files in order.
        const chunks = fs.readdirSync(tempDir)
            .filter(f => f.startsWith(chunkPrefix) && f.endsWith('.mp3'))
            .sort()
            .map(f => path.join(tempDir, f));
        createdChunks.push(...chunks);

        if (chunks.length === 0) {
            console.error('❌ [Whisper] ffmpeg produced no audio chunks.');
            cleanup();
            return null;
        }

        console.log(`🎙️ [Whisper] Transcribing ${chunks.length} chunk(s)...`);
        const client = getClient();

        const allSegments: TranscriptSegment[] = [];
        const textParts: string[] = [];
        let offsetMs = 0;   // running offset so timestamps stay continuous across chunks

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkMB = fs.statSync(chunk).size / (1024 * 1024);
            if (chunkMB > WHISPER_LIMIT_MB) {
                // Shouldn't happen at 48k mono, but guard anyway.
                console.warn(`   ⚠️ chunk ${i + 1} is ${chunkMB.toFixed(1)}MB (>limit) — skipping.`);
                offsetMs += CHUNK_SECONDS * 1000;
                continue;
            }

            const resp = await client.audio.transcriptions.create({
                file: fs.createReadStream(chunk),
                model: 'whisper-1',
                response_format: 'verbose_json',
                timestamp_granularities: ['segment'],
            });

            for (const seg of ((resp.segments || []) as Array<{ text: string; start: number; end: number }>)) {
                allSegments.push({
                    text: seg.text.trim(),
                    offset: Math.round(seg.start * 1000) + offsetMs,
                    duration: Math.round((seg.end - seg.start) * 1000),
                });
            }
            if (resp.text) textParts.push(resp.text.trim());

            // Advance the offset by this chunk's real duration (verbose_json
            // includes it); fall back to the nominal chunk length.
            const dur = (resp as unknown as { duration?: number }).duration;
            offsetMs += Math.round((dur ?? CHUNK_SECONDS) * 1000);
            console.log(`   ✅ chunk ${i + 1}/${chunks.length} transcribed`);
        }

        cleanup();

        const fullText = textParts.join(' ').trim() || allSegments.map(s => s.text).join(' ');
        if (!fullText) {
            console.error('❌ [Whisper] No transcript text produced.');
            return null;
        }

        console.log(`✅ [Whisper] Transcription complete (${fullText.length} chars across ${chunks.length} chunk(s)).`);
        return { text: fullText, segments: allSegments, source: 'whisper' };

    } catch (error) {
        console.error(`❌ [Whisper] Error processing video ${videoId}:`, error);
        cleanup();
        return null;
    }
}
