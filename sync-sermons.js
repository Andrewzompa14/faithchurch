const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// --- CONFIGURATION ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const YOUTUBE_CHANNEL_HANDLE = '@faithbaptistri';
const knownSeries = ["Matthew", "Psalms", "Romans", "1 Timothy", "David", "Revelation", "Easter", "Good Friday", "Fulfilled Promises"];

const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

initializeApp({
  credential: cert(FIREBASE_SERVICE_ACCOUNT)
});
const db = getFirestore();
const sermonsCollection = db.collection('sermons');

// --- HELPER FUNCTIONS ---
function extractSeries(title) {
    for (const series of knownSeries) {
        if (title.toLowerCase().startsWith(series.toLowerCase())) return series;
    }
    return "Standalone Message";
}

function cleanTitle(title) {
    return title.replace(/\s-\s(January|February|March|April|May|June|July|August|September|October|November|December)\s\d{1,2},?\s\d{4}$/, '').trim();
}

function parseISO8601Duration(duration) {
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = duration.match(regex);
    if (!matches) return 0;
    const hours = parseInt(matches[1] || 0);
    const minutes = parseInt(matches[2] || 0);
    const seconds = parseInt(matches[3] || 0);
    return (hours * 3600) + (minutes * 60) + seconds;
}

// --- MAIN LOGIC ---
async function syncSermons() {
    console.log('Starting sermon sync by comparing video IDs...');

    try {
        // 1. Get all existing sermon IDs from Firestore
        const existingSermonsSnapshot = await sermonsCollection.select().get();
        const existingSermonIds = new Set(existingSermonsSnapshot.docs.map(doc => doc.id));
        console.log(`Found ${existingSermonIds.size} existing sermons in the database.`);

        // 2. Get the YouTube Channel ID from its handle
        const channelResponse = await youtube.channels.list({
            part: 'id',
            forHandle: YOUTUBE_CHANNEL_HANDLE
        });
        const channelId = channelResponse.data.items[0]?.id;
        if (!channelId) throw new Error('Could not find YouTube channel.');

        // 3. Fetch the most recent 50 videos from the channel
        const searchResponse = await youtube.search.list({
            part: 'snippet',
            channelId: channelId,
            type: 'video',
            order: 'date',
            maxResults: 50 
        });
        
        const recentYouTubeVideoIds = searchResponse.data.items.map(item => item.id.videoId);

        // 4. Determine which videos are new
        const newVideoIds = recentYouTubeVideoIds.filter(id => !existingSermonIds.has(id));

        if (newVideoIds.length === 0) {
            console.log('No new sermons to add.');
            return;
        }
        console.log(`Found ${newVideoIds.length} new videos to process.`);

        // 5. Get full details for only the new videos
        const videosResponse = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: newVideoIds.join(',')
        });
        
        const newSermons = videosResponse.data.items
            .filter(video => parseISO8601Duration(video.contentDetails.duration) > 600) // Filter for > 10 minutes
            .map(video => ({
                id: video.id,
                title: cleanTitle(video.snippet.title),
                description: video.snippet.description,
                publishedAt: Timestamp.fromDate(new Date(video.snippet.publishedAt)),
                thumbnailUrl: video.snippet.thumbnails.high.url,
                series: extractSeries(video.snippet.title)
            }));

        if (newSermons.length === 0) {
            console.log('No new long-form sermons to add.');
            return;
        }

        // 6. Save only the new sermons to Firestore
        const batch = db.batch();
        newSermons.forEach(sermon => {
            const docRef = sermonsCollection.doc(sermon.id);
            batch.set(docRef, sermon);
        });

        await batch.commit();
        console.log(`Successfully synced ${newSermons.length} new sermons to Firestore!`);

    } catch (error) {
        console.error('Error during sermon sync:', error.response ? error.response.data.error : error.message);
        process.exit(1); // Exit with an error code
    }
}

syncSermons();