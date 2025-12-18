import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getClient } from './llm';
import { TranscriptResult, TranscriptSegment } from './transcript';

/**
 * Download audio from YouTube and transcribe it using OpenAI Whisper
 * This is a fallback method when standard captions are unavailable.
 * Requires 'yt-dlp' and 'ffmpeg' to be installed on the system.
 */
export async function transcribeWithWhisper(videoId: string): Promise<TranscriptResult | null> {
    const tempDir = os.tmpdir();
    const outputTemplate = path.join(tempDir, `hosksaid_${videoId}.%(ext)s`);
    // Ideally we want mp3 or m4a. Whisper supports m4a, mp3, webm, mp4, mpga, wav, mpeg.
    // yt-dlp -x extracts audio. --audio-format mp3 ensures compatibility.

    console.log(`🎙️ [Whisper] Downloading audio for ${videoId}...`);

    try {
        // Check if yt-dlp is available
        try {
            execSync('yt-dlp --version', { stdio: 'ignore' });
        } catch (e) {
            console.error('❌ yt-dlp is not installed or not found in PATH.');
            return null;
        }

        // Download audio
        // -x: extract audio
        // --audio-format mp3: convert to mp3
        // --audio-quality 5: medium quality (sufficient for speech, saves size)
        // -o: output template
        execSync(`yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${outputTemplate}" https://www.youtube.com/watch?v=${videoId}`, {
            stdio: 'inherit'
        });

        // Find the generated file (outputTemplate has %(ext)s, so the file will end in .mp3)
        const expectedFile = path.join(tempDir, `hosksaid_${videoId}.mp3`);

        if (!fs.existsSync(expectedFile)) {
            console.error(`❌ Failed to find downloaded audio file: ${expectedFile}`);
            return null;
        }

        const stats = fs.statSync(expectedFile);
        const fileSizeInMB = stats.size / (1024 * 1024);
        console.log(`🎙️ [Whisper] Audio downloaded (${fileSizeInMB.toFixed(2)} MB). Transcribing...`);

        // OpenAI Whisper API limit is 25MB.
        // If larger, we technically need to split it. For now, let's just error if too big 
        // to avoid complex splitting logic in MVP, or rely on compression quality=9 to keep it small.
        // With quality=5, 10 mins is ~5-10MB. 40 mins might hit the limit.
        if (fileSizeInMB > 24) {
            console.warn(`⚠️ Audio file is too large for Whisper API (${fileSizeInMB.toFixed(2)}MB > 25MB). Skipping.`);
            // Cleanup
            fs.unlinkSync(expectedFile);
            return null;
        }

        const client = getClient();

        const response = await client.audio.transcriptions.create({
            file: fs.createReadStream(expectedFile),
            model: 'whisper-1',
            response_format: 'verbose_json',
            timestamp_granularities: ['segment']
        });

        // Parse response
        // The response with verbose_json includes 'segments' array
        const manualSegments: TranscriptSegment[] = (response.segments || []).map((seg: any) => ({
            text: seg.text.trim(),
            offset: Math.round(seg.start * 1000),
            duration: Math.round((seg.end - seg.start) * 1000)
        }));

        const fullText = response.text || manualSegments.map(s => s.text).join(' ');

        // Cleanup
        fs.unlinkSync(expectedFile);

        console.log(`✅ [Whisper] Transcription complete (${fullText.length} chars).`);

        return {
            text: fullText,
            segments: manualSegments,
            source: 'whisper'
        };

    } catch (error) {
        console.error(`❌ [Whisper] Error processing video ${videoId}:`, error);

        // Try to cleanup if file exists
        const expectedFile = path.join(tempDir, `hosksaid_${videoId}.mp3`);
        if (fs.existsSync(expectedFile)) {
            fs.unlinkSync(expectedFile);
        }

        return null;
    }
}
