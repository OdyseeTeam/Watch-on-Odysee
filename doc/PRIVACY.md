Watch on Odysee – Privacy Policy

Effective date: 2025-08-20

Summary
- The extension does not collect, transmit, sell, or share personal data.
- All settings are stored locally using `chrome.storage.local` and can be changed or cleared by the user at any time.
- A small cache of non-personal identifiers (YouTube video/channel IDs and their resolved Odysee paths) is stored locally in IndexedDB to improve performance. You can clear this cache from the extension popup.
- The extension communicates only with the public Odysee API to resolve YouTube IDs to Odysee paths: `https://api.odysee.com/yt/resolve` (path may vary). Requests contain only the YouTube IDs required to perform the lookup.
- No analytics, tracking, cookies, or advertising SDKs are used.

Data We Process
- Local settings: feature toggles such as redirect options and button visibility.
- Local cache: mappings between YouTube IDs and Odysee paths with expiration timestamps.

Data Sharing
- No personal data is shared. Network requests to Odysee APIs include only the IDs necessary to find matching content.

Permissions
- Storage: used to save your settings locally.
- Content scripts: run only on YouTube/Invidious pages to render buttons and perform redirects. No browsing history is read.

User Controls
- You may clear the cache from the popup (Clear Resolver Cache) and remove the extension to delete all associated data.

Contact
For questions about this policy or the extension, please open an issue in the repository.


