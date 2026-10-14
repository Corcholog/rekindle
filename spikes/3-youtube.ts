// Spike 3: YouTube Transcript
import { YoutubeTranscript } from 'youtube-transcript';

async function run() {
  try {
    const videoUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", first YT video
    const transcript = await YoutubeTranscript.fetchTranscript(videoUrl);
    
    if (transcript && transcript.length > 0) {
      console.log(`GO: Fetched transcript with ${transcript.length} parts.`);
      console.log(`Sample: ${transcript[0].text}`);
    } else {
      console.log("NO-GO: Empty transcript.");
    }
  } catch (err) {
    console.error("NO-GO or Error:", err);
  }
}

run().catch(console.error);
