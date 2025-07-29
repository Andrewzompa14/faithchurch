// This script is designed to be run automatically (e.g., once a day) by a service like GitHub Actions.
// It fetches all long-form videos from your YouTube channel, processes them, and saves them to your Firestore database.

// Required libraries for Node.js environment
const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- CONFIGURATION ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const YOUTUBE_CHANNEL_HANDLE = '@faithbaptistri';
const knownSeries = ["Matthew", "Psalms", "Romans", "1 Timothy", "David", "Revelation", "Easter", "Good Friday", "Fulfilled Promises"];

const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

// Initialize Firebase Admin
initializeApp({
  credential: cert(FIREBASE_SERVICE_ACCOUNT)
});
const db = getFirestore();

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

// --- MAIN LOGIC ---
async function syncSermons() {
    console.log('Starting sermon sync...');

    try {
        // 1. Get Channel ID
        const channelResponse = await youtube.channels.list({
            part: 'id',
            forHandle: YOUTUBE_CHANNEL_HANDLE
        });
        const channelId = channelResponse.data.items[0].id;
        if (!channelId) throw new Error('Could not find YouTube channel.');
        console.log(`Found Channel ID: ${channelId}`);

        // 2. Fetch all long-form videos using the efficient search method
        const mediumVideos = await fetchAllYouTubeSearch(channelId, 'medium');
        const longVideos = await fetchAllYouTubeSearch(channelId, 'long');
        
        let allSermons = [...mediumVideos, ...longVideos]
            .sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt))
            .map(video => ({
                id: video.id.videoId,
                title: cleanTitle(video.snippet.title),
                description: video.snippet.description,
                publishedAt: video.snippet.publishedAt,
                thumbnailUrl: video.snippet.thumbnails.high.url,
                series: extractSeries(video.snippet.title)
            }));
        
        console.log(`Found ${allSermons.length} total sermons.`);

        // 3. Save to Firestore
        const batch = db.batch();
        const sermonsCollection = db.collection('sermons');
        
        // Optional: Delete old sermons first to ensure a clean slate
        const oldSermons = await sermonsCollection.get();
        oldSermons.forEach(doc => batch.delete(doc.ref));

        // Add new sermons
        allSermons.forEach(sermon => {
            const docRef = sermonsCollection.doc(sermon.id); // Use YouTube video ID as the document ID
            batch.set(docRef, sermon);
        });

        await batch.commit();
        console.log('Successfully synced all sermons to Firestore!');

    } catch (error) {
        console.error('Error during sermon sync:', error);
        process.exit(1); // Exit with an error code
    }
}

async function fetchAllYouTubeSearch(channelId, duration) {
    let allItems = [];
    let nextPageToken = null;
    do {
        const response = await youtube.search.list({
            part: 'snippet',
            channelId: channelId,
            type: 'video',
            videoDuration: duration,
            order: 'date',
            maxResults: 50,
            pageToken: nextPageToken
        });
        allItems = allItems.concat(response.data.items);
        nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);
    return allItems;
}

syncSermons();
