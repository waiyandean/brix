// SALSA 1.5 — process control / batch quality records
// Brix/refractometer reading receiver → Google Drive (photos) + Google Sheets (row)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Google auth ────────────────────────────────────────────────────────────────

function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlBytes(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function buildJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: env.SA_EMAIL,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const unsigned = `${header}.${claims}`;

  // Strip PEM headers, decode to DER
  const pemBody = env.SA_PRIVATE_KEY
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${b64urlBytes(sig)}`;
}

async function getAccessToken(env) {
  const jwt = await buildJWT(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Google Drive upload ────────────────────────────────────────────────────────

async function uploadPhoto(token, filename, base64Data, mimeType, folderId) {
  const boundary = 'brix_mp_boundary';
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Data,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  const data = await res.json();
  if (!data.id) throw new Error(`Drive upload failed: ${JSON.stringify(data)}`);

  // Make file readable by anyone with link (for Sheet hyperlink preview)
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return data.webViewLink;
}

// ── Google Sheets append ───────────────────────────────────────────────────────

async function appendRow(token, sheetId, tab, row) {
  const range = encodeURIComponent(`${tab}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const data = await res.json();
  if (!data.updates) throw new Error(`Sheets error: ${JSON.stringify(data)}`);
}

// ── Request handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { status: 'error', message: 'Invalid JSON body' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const {
      date, batchNumber, product,
      readingBefore, readingAfter,
      photoBeforeName, photoBeforeData, photoBeforeType,
      photoAfterName,  photoAfterData,  photoAfterType,
      actions,
    } = payload;

    if (!date || !batchNumber || !product || !readingBefore || !photoBeforeData) {
      return Response.json(
        { status: 'error', message: 'Missing required fields' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    try {
      const token = await getAccessToken(env);
      const timestamp = new Date().toISOString();

      // Upload before photo (required)
      const safeDate = date.replace(/-/g, '');
      const beforeUrl = await uploadPhoto(
        token,
        `${safeDate}_${batchNumber}_before_${photoBeforeName}`,
        photoBeforeData,
        photoBeforeType || 'image/jpeg',
        env.DRIVE_FOLDER_ID
      );

      // Upload after photo (optional)
      let afterUrl = '';
      if (photoAfterData) {
        afterUrl = await uploadPhoto(
          token,
          `${safeDate}_${batchNumber}_after_${photoAfterName}`,
          photoAfterData,
          photoAfterType || 'image/jpeg',
          env.DRIVE_FOLDER_ID
        );
      }

      // Sheet columns: Timestamp | Date | Batch | Product | Before°Bx | After°Bx | Photo Before | Photo After | Actions
      await appendRow(token, env.SHEET_ID, env.SHEET_TAB, [
        timestamp,
        date,
        batchNumber,
        product,
        Number(readingBefore),
        readingAfter ? Number(readingAfter) : '',
        beforeUrl,
        afterUrl,
        actions || '',
      ]);

      return Response.json({ status: 'ok' }, { headers: CORS_HEADERS });

    } catch (err) {
      console.error(err.message);
      return Response.json(
        { status: 'error', message: err.message },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },
};
