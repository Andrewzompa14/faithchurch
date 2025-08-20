// This script is designed to be run automatically (e.g., once a day) by a service like GitHub Actions.
// It efficiently fetches only the NEW long-form videos from your YouTube channel and saves them to your Firestore database.

const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

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

// --- MAIN LOGIC ---
async function syncSermons() {
    console.log('Starting efficient sermon sync...');

    try {
        // 1. Get the last synced sermon's date from Firestore
        const lastSermonQuery = await sermonsCollection.orderBy('publishedAt', 'desc').limit(1).get();
        let lastSyncDate = null;
        if (!lastSermonQuery.empty) {
            lastSyncDate = lastSermonQuery.docs[0].data().publishedAt.toDate().toISOString();
            console.log(`Last sync date found: ${lastSyncDate}`);
        } else {
            console.log('No previous sermons found in database. Fetching all history.');
        }

        // 2. Get Channel ID
        const channelResponse = await youtube.channels.list({
            part: 'id',
            forHandle: YOUTUBE_CHANNEL_HANDLE
        });
        const channelId = channelResponse.data.items[0].id;
        if (!channelId) throw new Error('Could not find YouTube channel.');

        // 3. Fetch only NEW videos since the last sync
        const newVideos = await fetchNewYouTubeVideos(channelId, lastSyncDate);
        
        if (newVideos.length === 0) {
            console.log('No new sermons to add.');
            return;
        }

        console.log(`Found ${newVideos.length} new sermons to process and add.`);

        // 4. Get full details for only the new videos
        const videoIds = newVideos.map(video => video.id.videoId);
        const videosResponse = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: videoIds.join(',')
        });
        
        const longFormVideos = videosResponse.data.items
            .filter(video => parseISO8601Duration(video.contentDetails.duration) > 600) // Filter for > 10 minutes
            .map(video => ({
                id: video.id,
                title: cleanTitle(video.snippet.title),
                description: video.snippet.description,
                publishedAt: Timestamp.fromDate(new Date(video.snippet.publishedAt)),
                thumbnailUrl: video.snippet.thumbnails.high.url,
                series: extractSeries(video.snippet.title)
            }));

        if (longFormVideos.length === 0) {
            console.log('No new long-form sermons to add.');
            return;
        }

        // 5. Save only the new sermons to Firestore
        const batch = db.batch();
        longFormVideos.forEach(sermon => {
            const docRef = sermonsCollection.doc(sermon.id);
            batch.set(docRef, sermon);
        });

        await batch.commit();
        console.log(`Successfully synced ${longFormVideos.length} new sermons to Firestore!`);

    } catch (error) {
        console.error('Error during sermon sync:', error.response ? error.response.data.error : error.message);
        process.exit(1); // Exit with an error code
    }
}

async function fetchNewYouTubeVideos(channelId, publishedAfter) {
    let allItems = [];
    let nextPageToken = null;
    do {
        const response = await youtube.search.list({
            part: 'snippet',
            channelId: channelId,
            type: 'video',
            order: 'date',
            maxResults: 50,
            publishedAfter: publishedAfter, // This is the key to efficiency
            pageToken: nextPageToken
        });
        allItems = allItems.concat(response.data.items);
        nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);
    return allItems;
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

syncSermons();
