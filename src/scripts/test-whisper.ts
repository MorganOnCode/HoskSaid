import { transcribeWithWhisper } from '../lib/whisper';
import { config } from 'dotenv';
config(); // reads .env

async function test() {
    const videoId = 'VZiqLsch6Vs'; // Short video: RIP Rob Reiner (~3m)
    console.log(`🧪 Testing Whisper transcription for video: ${videoId}`);

    try {
        const start = Date.now();
        const result = await transcribeWithWhisper(videoId);
        const duration = (Date.now() - start) / 1000;

        if (result) {
            console.log('\n✅ Transcription Successful!');
            console.log(`⏱️ Time taken: ${duration.toFixed(2)}s`);
            console.log(`📝 Text length: ${result.text.length} chars`);
            console.log(`🗣️ Segments: ${result.segments.length}`);
            console.log('\nPreview (first 500 chars):');
            console.log('--------------------------------------------------');
            console.log(result.text.slice(0, 500));
            console.log('--------------------------------------------------');
        } else {
            console.log('❌ Transcription return null');
        }
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

test();
