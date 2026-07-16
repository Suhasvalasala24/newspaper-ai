// NewsAI Extension — Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[NewsAI] Extension installed. Click the toolbar icon to add your Gemini API key.');
});

// Respond to ping from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEWSAI_GET_KEY') {
    // Read both key names for backward compatibility
    chrome.storage.local.get(['newsai_api_key', 'newsai_groq_key'], result => {
      sendResponse({ key: result.newsai_api_key || result.newsai_groq_key || '' });
    });
    return true; // keep channel open for async
  }
  if (message.type === 'NEWSAI_PING') {
    sendResponse({ status: 'ok', version: '1.1.0' });
  }
});
