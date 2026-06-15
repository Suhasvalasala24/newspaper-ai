// NewsAI Extension — Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[NewsAI] Extension installed. Open the popup to add your Groq API key.');
});

// Respond to ping from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEWSAI_GET_KEY') {
    chrome.storage.local.get(['newsai_groq_key'], result => {
      sendResponse({ key: result.newsai_groq_key || '' });
    });
    return true; // keep channel open for async
  }
  if (message.type === 'NEWSAI_PING') {
    sendResponse({ status: 'ok', version: '1.0.0' });
  }
});
