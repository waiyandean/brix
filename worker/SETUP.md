# Brix Worker — Setup

Cloudflare Worker that receives brix form submissions, uploads photos to Google Drive, and appends a row to Google Sheets.

## Prerequisites

1. **Cloudflare account** — free tier works (100k req/day)
2. **Google service account** with these APIs enabled:
   - Google Sheets API
   - Google Drive API
3. **Service account key** (JSON) downloaded from Google Cloud Console
4. **Google Drive folder** to receive photos — note its ID from the URL

---

## Step 1 — Create Google service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create Service Account → download JSON key
3. Enable **Google Sheets API** and **Google Drive API** in the project
4. Share the **target Sheet** with the service account email (Editor role)
5. Share the **target Drive folder** with the service account email (Editor role)

---

## Step 2 — Deploy the Worker

```bash
npm install -g wrangler
wrangler login

cd brix-worker

# Set secrets (values from the service account JSON key)
wrangler secret put SA_EMAIL
# paste: client_email value from JSON key

wrangler secret put SA_PRIVATE_KEY
# paste: private_key value from JSON key (include -----BEGIN/END----- lines)

wrangler secret put DRIVE_FOLDER_ID
# paste: the folder ID from the Google Drive URL
# e.g. drive.google.com/drive/folders/1ABC123... → ID is 1ABC123...

wrangler deploy
```

After deploy, Wrangler prints the Worker URL:
```
https://brix-worker.<your-subdomain>.workers.dev
```

---

## Step 3 — Create the Sheet tab

In the existing sheet (`M&R Batch Records`), add a tab named **Brix Readings** with these headers in row 1:

```
Timestamp | Date | Batch Number | Product | Reading Before (°Bx) | Reading After (°Bx) | Photo Before | Photo After | Actions
```

---

## Step 4 — Update the form HTML

In `waiyandean/brix/index.html`, make two changes:

**A. Replace the URL constant** (line ~639):
```js
// OLD
const APPS_SCRIPT_URL = 'https://script.google.com/...';

// NEW
const WORKER_URL = 'https://brix-worker.<your-subdomain>.workers.dev';
```

**B. Update the fetch and payload** (in the submit handler):
```js
// Add to payload object:
photoBeforeType: beforeFile.type,
photoAfterType:  afterFile?.type ?? '',

// Change fetch call:
const response = await fetch(WORKER_URL, {   // was APPS_SCRIPT_URL
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

**C. Remove the Apps Script note** at the bottom (optional cosmetic cleanup).

---

## Verify

Submit a test reading. Check:
- Photo appears in the Drive folder
- Row appears in the `Brix Readings` tab with Drive links in columns G/H

---

## Costs

| Resource | Free tier | Typical usage |
|---|---|---|
| Worker requests | 100k/day | ~5/day |
| Drive storage | 15 GB (personal) | ~1 MB/photo |
| Sheets writes | free | negligible |
