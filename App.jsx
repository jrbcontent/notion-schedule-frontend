import React, { useState, useCallback, useMemo } from 'react';

// --- UTILITY FUNCTIONS FOR BASE64 AND EXPONENTIAL BACKOFF ---

/** Converts a File object to a Base64 encoded string for the Gemini API. */
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = (error) => reject(error);
    });
};

/** Exponential backoff retry function for API calls. */
const fetchWithRetry = async (url, options, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // Throw an error to trigger the catch block and retry (unless it's a 4xx client error)
                if (response.status >= 400 && response.status < 500) {
                    const errorBody = await response.json();
                    throw new Error(`Client Error (${response.status}): ${errorBody.message || 'Check Notion Database/Token access.'}`);
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s, ...
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

/**
 * Handles the AI image analysis and returns structured event data.
 * NOTE: This is complex and requires exponential backoff and error handling.
 */
const analyzeImageWithGemini = async (base64Image) => {
    const userQuery = `Analyze the events in this image. For each event, extract the main artist, the full lineup (all artists listed), the date in YYYY-MM-DD format, and the venue/location. Return only a JSON array matching the schema provided below. DO NOT include any explanatory text outside the JSON.
    
    Schema:
    [
        {
            "mainArtist": "string",
            "fullLineup": "string (comma-separated list of all artists)",
            "date": "YYYY-MM-DD",
            "location": "Venue Name, City, State"
        }
    ]
    `;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: userQuery },
                    {
                        inlineData: {
                            mimeType: "image/jpeg", // Assuming JPEG/PNG for screenshots
                            data: base64Image
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            // The model is instructed to follow the schema via the prompt
        }
    };

    const apiKey = ""; // Canvas provides this key at runtime
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const result = await response.json();
    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonText) {
        throw new Error("AI did not return structured data. Please ensure the image text is clear.");
    }
    
    try {
        // The model sometimes wraps the JSON in markdown fences, so we strip them
        const cleanedJsonText = jsonText.replace(/^```json\s*|```$/g, '').trim();
        return JSON.parse(cleanedJsonText);
    } catch (e) {
        console.error("Failed to parse AI response:", jsonText);
        throw new Error("Failed to parse AI response into a structured JSON list.");
    }
};

// --- MAIN APPLICATION COMPONENT ---

const App = () => {
    // --- IMPORTANT: CONFIGURE YOUR API ENDPOINTS AND IDS HERE ---
    // 1. LIVE PROXY URL (The Vercel domain you just confirmed) - CONFIGURATION COMPLETE!
    const NOTION_PROXY_URL = "https://vercel-repository-henna.vercel.app/api/notion-event-creator"; 

    // 2. CONTACTS DB ID (ID of your EDM Master List) - CONFIGURATION COMPLETE!
    const NOTION_CONTACTS_DB_ID = "293651ecdc6080bda539d48ff253f61b"; 
    
    // 3. CALENDAR DB ID (ID of your EDM Schedule Calendar) - CONFIGURATION COMPLETE!
    const NOTION_CALENDAR_DB_ID = "293651ecdc608039b618dfbf2769011c"; 

    const [file, setFile] = useState(null);
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [contacts, setContacts] = useState([]); // Placeholder for contact list (not yet fetched securely)


    // ----------------------------------------------------------------------
    // --- NOTION AND DATA PROCESSING LOGIC ---
    // ----------------------------------------------------------------------

    /**
     * Finds contact info for an artist (placeholder function).
     * In a full implementation, this would involve fetching from a secure endpoint.
     */
    const getContactInfo = (artistName) => {
        // This is a simplified lookup using the local contacts state.
        // For the full secure solution, a separate proxy fetch is needed.
        const contact = contacts.find(c => c.artist.toLowerCase() === artistName.toLowerCase());
        return contact || { 
            manager: '[MANAGER NAME HERE]', 
            email: '[MANAGER EMAIL HERE]', 
            phone: '[MANAGER PHONE HERE]' 
        };
    };

    /**
     * Constructs the detailed description text for the Notion page.
     */
    const generateDescription = (event) => {
        const mainContact = getContactInfo(event.mainArtist);
        
        let description = `***TOUR/EVENT NOTES***\n\n`;
        description += `**Main Artist: ${event.mainArtist}**\n`;
        description += `Full Lineup: ${event.fullLineup || event.mainArtist}\n\n`;
        
        description += `***MANAGEMENT CONTACTS***\n`;
        description += `Manager: ${mainContact.manager}\n`;
        description += `Email: ${mainContact.email}\n`;
        description += `Phone: ${mainContact.phone}\n`;

        // Optional: Add a section for all artists in the lineup (if contacts were found)
        const otherArtists = (event.fullLineup || '').split(',').map(a => a.trim()).filter(a => a && a !== event.mainArtist);
        if (otherArtists.length > 0) {
            description += `\n***OTHER LINEUP CONTACTS***\n`;
            otherArtists.forEach(artist => {
                 const contact = getContactInfo(artist);
                 description += `- ${artist}: ${contact.manager} (${contact.email})\n`;
            });
        }

        return description;
    };


    /**
     * Sends a single event to the Vercel proxy to be created in Notion.
     */
    const createNotionPage = async (event) => {
        if (!NOTION_PROXY_URL || !NOTION_CALENDAR_DB_ID) {
            setMessage("ERROR: Configuration error. NOTION_PROXY_URL or NOTION_CALENDAR_DB_ID is missing.");
            return;
        }

        const subject = `${event.mainArtist}: ${event.location.split(',')[0].trim()}`;
        const description = generateDescription(event);

        const payload = {
            subject: subject, // e.g., 'Dirt Monkey: Crofoot Ballroom'
            date: event.date, // YYYY-MM-DD
            location: event.location, // e.g., 'Crofoot Ballroom, Pontiac, MI'
            description: description, // Full notes with contacts
        };
        
        // Call the secure Vercel proxy function
        const response = await fetchWithRetry(NOTION_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        
        if (response.ok) {
            // Success! Update the event status in the UI
            setEvents(prevEvents => prevEvents.map(e => 
                e.id === event.id ? { ...e, status: 'Success', pageId: result.notionPageId } : e
            ));
            return true;
        } else {
            // Failure
            setEvents(prevEvents => prevEvents.map(e => 
                e.id === event.id ? { ...e, status: `Failed: ${result.message}` } : e
            ));
            throw new Error(result.message || "Failed to create page via proxy.");
        }
    };

    // ----------------------------------------------------------------------
    // --- HANDLERS ---
    // ----------------------------------------------------------------------

    /**
     * Main handler: Analyzes the uploaded image and adds events to the list.
     */
    const handleAnalyzeImage = useCallback(async () => {
        if (!file) {
            setMessage("Please select an image file first.");
            return;
        }
        
        setLoading(true);
        setMessage("Analyzing image and extracting event details...");
        
        try {
            const base64Image = await fileToBase64(file);
            const structuredEvents = await analyzeImageWithGemini(base64Image);
            
            // Map the AI output to our local event structure
            const newEvents = structuredEvents.map((event, index) => ({
                id: Date.now() + index, // Simple unique ID
                ...event,
                status: 'Ready to Sync',
                pageId: null,
            }));
            
            setEvents(prev => [...prev, ...newEvents]);
            setMessage(`Successfully extracted ${newEvents.length} events. Review below and click 'Sync All to Notion'.`);

        } catch (error) {
            setMessage(`AI Analysis Failed: ${error.message}`);
        } finally {
            setLoading(false);
        }
    }, [file]);

    /**
     * Syncs all "Ready to Sync" events to Notion one by one.
     */
    const handleSyncAll = useCallback(async () => {
        if (events.length === 0) {
            setMessage("No events to sync.");
            return;
        }
        setLoading(true);
        setMessage("Starting sync process...");
        
        let successCount = 0;
        let failCount = 0;
        
        // Loop through all events marked as 'Ready to Sync'
        for (const event of events.filter(e => e.status === 'Ready to Sync')) {
            setMessage(`Syncing: ${event.mainArtist} on ${event.date}...`);
            try {
                await createNotionPage(event);
                successCount++;
            } catch (error) {
                failCount++;
                console.error(`Sync failed for ${event.mainArtist}:`, error);
            }
        }
        
        setMessage(`Sync Complete! ${successCount} events synced successfully, ${failCount} failed.`);
        setLoading(false);
    }, [events, createNotionPage]);


    // ----------------------------------------------------------------------
    // --- UI RENDERING ---
    // ----------------------------------------------------------------------

    const EventTable = useMemo(() => (
        <div className="overflow-x-auto bg-white rounded-lg shadow-xl mt-6">
            <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Subject</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Venue</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {events.map((event) => (
                        <tr key={event.id} className={event.status === 'Success' ? 'bg-green-50' : event.status.includes('Failed') ? 'bg-red-50' : ''}>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                {`${event.mainArtist} - ${event.location.split(',')[0].trim()}`}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{event.date}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{event.location}</td>
                            <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold ${event.status === 'Success' ? 'text-green-600' : event.status.includes('Failed') ? 'text-red-600' : 'text-blue-500'}`}>
                                {event.status}
                                {event.pageId && (
                                    <span className="block text-xs font-normal text-gray-400">ID: {event.pageId.substring(0, 8)}...</span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    ), [events]);


    return (
        <div className="p-4 sm:p-8 min-h-screen bg-gray-50 font-sans">
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />

            <style>{`
                body { font-family: 'Inter', sans-serif; }
                .card { background-color: white; border-radius: 12px; padding: 24px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); }
            `}</style>
            
            <div className="max-w-4xl mx-auto">
                <header className="text-center mb-10">
                    <h1 className="text-4xl font-extrabold text-indigo-700">Notion Schedule Sync</h1>
                    <p className="mt-2 text-gray-600">
                        Image Analysis to Notion Calendar via Secure Vercel Proxy
                    </p>
                </header>

                {/* --- CONFIGURATION SUCCESS MESSAGE --- */}
                <div className="card mb-8 p-4 bg-green-50 border-l-4 border-green-400">
                    <p className="text-sm font-semibold text-green-800">
                        <span className="font-bold">SETUP COMPLETE:</span> The app is fully configured to use your Notion databases and your live Vercel Proxy.
                    </p>
                </div>


                {/* --- STEP 1: IMAGE UPLOAD AND ANALYSIS --- */}
                <div className="card mb-8">
                    <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                        1. AI Schedule Extractor 
                    </h2>
                    <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4 items-center">
                        <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                                setFile(e.target.files[0]);
                                setMessage('');
                            }}
                            className="flex-grow w-full sm:w-auto text-sm text-gray-500
                                file:mr-4 file:py-2 file:px-4
                                file:rounded-full file:border-0
                                file:text-sm file:font-semibold
                                file:bg-indigo-50 file:text-indigo-700
                                hover:file:bg-indigo-100"
                        />
                        <button
                            onClick={handleAnalyzeImage}
                            disabled={loading || !file}
                            className="w-full sm:w-auto px-6 py-2 bg-indigo-600 text-white font-semibold rounded-full shadow-md hover:bg-indigo-700 transition duration-150 disabled:bg-indigo-300 disabled:cursor-not-allowed flex items-center justify-center"
                        >
                            {loading ? (
                                <>
                                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    Analyzing...
                                </>
                            ) : (
                                'Analyze & Extract Events'
                            )}
                        </button>
                    </div>
                    {message && (
                        <p className={`mt-4 text-sm font-medium ${message.startsWith('ERROR') ? 'text-red-600' : 'text-gray-700'}`}>
                            {message}
                        </p>
                    )}
                </div>
                
                {/* --- STEP 2: REVIEW AND SYNC --- */}
                {events.length > 0 && (
                    <div className="card">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 flex justify-between items-center">
                            <span>2. Review & Sync to Notion ({events.length} Events)</span>
                            <button
                                onClick={handleSyncAll}
                                disabled={loading || events.filter(e => e.status === 'Ready to Sync').length === 0}
                                className="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-full shadow-md hover:bg-emerald-700 transition duration-150 disabled:bg-emerald-300 disabled:cursor-not-allowed"
                            >
                                Sync All to Notion
                            </button>
                        </h2>
                        
                        {EventTable}

                        <p className="mt-4 text-sm text-gray-500 italic">
                            Events are sent to your Vercel Proxy, which securely writes them to your **EDM Schedule Calendar** database.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default App;
