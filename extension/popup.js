const keyInput     = document.getElementById('key-input');
const saveBtn      = document.getElementById('save-btn');
const feedback     = document.getElementById('feedback');
const statusBanner = document.getElementById('status-banner');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const providerTag  = document.getElementById('provider-tag');

// Detect provider from key prefix
function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  return 'unknown';
}

function providerLabel(key) {
  const p = detectProvider(key);
  if (p === 'gemini')    return '✨ Gemini 2.0 Flash';
  if (p === 'groq')      return '⚡ Groq (llama-3.1-8b)';
  if (p === 'anthropic') return '🤖 Claude (Anthropic)';
  return '❓ Unknown provider';
}

function setReady(key) {
  const masked = key.length > 12
    ? key.slice(0, 8) + '••••' + key.slice(-4)
    : key.slice(0, 4) + '••••';
  statusBanner.className = 'status-banner ready';
  statusDot.style.background = '#4caf50';
  statusText.textContent = '✅ Key saved: ' + masked + ' — Visit eenadu.net to use the assistant.';
  if (providerTag) providerTag.textContent = providerLabel(key);
  keyInput.value = key;
}

function setMissing() {
  statusBanner.className = 'status-banner missing';
  statusDot.style.background = '#ffa726';
  statusText.textContent = '⚠️ No API key saved. Get a free Gemini key at aistudio.google.com';
  if (providerTag) providerTag.textContent = '';
  keyInput.value = '';
}

// Load saved key on popup open
chrome.storage.local.get(['newsai_groq_key'], function (result) {
  const key = result.newsai_groq_key;
  if (key && key.length > 4) {
    setReady(key);
  } else {
    setMissing();
  }
});

// Save on button click
saveBtn.addEventListener('click', function () {
  const key = keyInput.value.trim();
  if (!key || key.length < 20) {
    feedback.textContent = '❌ Key too short — paste the full key from aistudio.google.com or console.groq.com.';
    feedback.className = 'feedback err';
    return;
  }

  // Block Google OAuth tokens — "AQ." / "ya29." come from the wrong page in AI Studio
  if (key.startsWith('AQ.') || key.startsWith('ya29.')) {
    feedback.textContent = '❌ That\'s a Google OAuth token, not an API key. Go to aistudio.google.com/apikey → click "Create API key". Your key should start with "AIza".';
    feedback.className = 'feedback err';
    return;
  }

  const provider = detectProvider(key);
  if (provider === 'unknown') {
    feedback.textContent = '❌ Key format not recognised. Gemini keys start with "AIza", Groq keys start with "gsk_". Please check and try again.';
    feedback.className = 'feedback err';
    return;
  }

  saveBtn.textContent = 'Saving...';
  saveBtn.className = 'save-btn saving';

  // Store under the same key for backwards compatibility
  chrome.storage.local.set({ newsai_groq_key: key }, function () {
    if (chrome.runtime.lastError) {
      feedback.textContent = '❌ Save failed: ' + chrome.runtime.lastError.message;
      feedback.className = 'feedback err';
    } else {
      feedback.textContent = '✅ Saved! Refresh eenadu.net to activate.';
      feedback.className = 'feedback ok';
      setReady(key);
    }
    saveBtn.textContent = 'Save';
    saveBtn.className = 'save-btn';
  });
});

// Show provider tag while typing
keyInput.addEventListener('input', function () {
  feedback.textContent = '';
  feedback.className = 'feedback';
  const p = detectProvider(keyInput.value.trim());
  if (providerTag) providerTag.textContent = p && p !== 'unknown' ? providerLabel(keyInput.value.trim()) : '';
});

// Save on Enter
keyInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') saveBtn.click();
});
