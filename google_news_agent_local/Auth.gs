/**
 * Auth.gs — Vertex AI service account authentication.
 *
 * Vertex needs an OAuth2 bearer token, not an API key. This mints one from
 * the service account JSON using the JWT-bearer flow:
 *
 *   build claim -> sign RS256 with the private key -> POST to Google's token
 *   endpoint -> receive access_token (valid 1h) -> cache it
 *
 * Apps Script can do RS256 natively via Utilities.computeRsaSha256Signature,
 * so this needs no external library.
 *
 * The key itself lives in Script Properties under VERTEX_SA_KEY — never in
 * this source. See README for the paste-once setup.
 */

const SA_PROPERTY = 'VERTEX_SA_KEY';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TOKEN_CACHE_KEY = 'vertex_access_token';

// Tokens live 3600s. Cache slightly under that so we never present one that
// expires mid-flight during a long batch.
const TOKEN_CACHE_SECONDS = 3300;

/**
 * A valid Vertex access token, cached across executions.
 * @return {string}
 */
function vertexAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const serviceAccount = loadServiceAccount_();
  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;
  const assertion = buildSignedJwt_(serviceAccount, tokenUri);

  const response = UrlFetchApp.fetch(tokenUri, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion,
    },
  });

  const token = readTokenResponse_(response);
  cache.put(TOKEN_CACHE_KEY, token, TOKEN_CACHE_SECONDS);
  return token;
}

/**
 * Reads and validates the service account JSON out of Script Properties.
 * Every failure here is a setup mistake, so each one names the fix.
 */
function loadServiceAccount_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SA_PROPERTY);
  if (!raw || !raw.trim()) {
    throw new Error(
      `Missing ${SA_PROPERTY}. Open Project Settings > Script Properties, add a property ` +
      `named ${SA_PROPERTY}, and paste the entire contents of your Vertex service account ` +
      `JSON file as the value.`
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${SA_PROPERTY} is not valid JSON. Paste the whole key file verbatim, starting with { ` +
      `and ending with } — do not reformat it or strip the \\n escapes out of private_key.`
    );
  }

  if (serviceAccount.type !== 'service_account') {
    throw new Error(
      `${SA_PROPERTY} is not a service account key (type is "${serviceAccount.type}"). ` +
      `You may have pasted an OAuth client secret instead. The right file comes from ` +
      `IAM & Admin > Service Accounts > Keys > Add key > JSON.`
    );
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error(`${SA_PROPERTY} is missing client_email or private_key.`);
  }

  return serviceAccount;
}

function buildSignedJwt_(serviceAccount, tokenUri) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: serviceAccount.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };

  const signingInput =
    base64Url_(Utilities.newBlob(JSON.stringify(header)).getBytes()) + '.' +
    base64Url_(Utilities.newBlob(JSON.stringify(claim)).getBytes());

  const signature = Utilities.computeRsaSha256Signature(signingInput, serviceAccount.private_key);
  return signingInput + '.' + base64Url_(signature);
}

/** JWT wants base64url with the padding stripped. */
function base64Url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function readTokenResponse_(response) {
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    // The token endpoint returns genuinely useful errors — surface them whole.
    throw new Error(
      `Vertex token exchange failed (${code}): ${text.slice(0, 400)}\n` +
      `Common causes: the service account lacks the "Vertex AI User" role, the Vertex AI API ` +
      `is not enabled on the project, or the key has been revoked.`
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!body.access_token) {
    throw new Error(`Token endpoint returned no access_token: ${text.slice(0, 200)}`);
  }
  return body.access_token;
}

/** Drops the cached token. Call after rotating the key. */
function clearVertexTokenCache() {
  CacheService.getScriptCache().remove(TOKEN_CACHE_KEY);
  Logger.log('Cached Vertex token cleared.');
}

/**
 * Verifies the whole Vertex setup without spending model quota:
 * key parses, JWT signs, token exchanges, config is filled in.
 * Run this first after pasting the key.
 */
function checkVertexAuth() {
  if (CONFIG.GEMINI_BACKEND !== 'vertex') {
    Logger.log(`GEMINI_BACKEND is "${CONFIG.GEMINI_BACKEND}", not "vertex" — nothing to check.`);
    return;
  }

  const serviceAccount = loadServiceAccount_();
  Logger.log(`Key parsed. Service account: ${serviceAccount.client_email}`);
  Logger.log(`Key's own project: ${serviceAccount.project_id}`);

  clearVertexTokenCache();
  const token = vertexAccessToken_();
  Logger.log(`Token exchange succeeded (${token.length} chars).`);

  // The key already names its project, so an empty setting has an obvious
  // answer. Hand it over instead of just reporting "empty".
  if (!String(CONFIG.VERTEX_PROJECT_ID || '').trim()) {
    Logger.log(
      `\nCONFIG.VERTEX_PROJECT_ID is empty. Your key belongs to "${serviceAccount.project_id}" — ` +
      `that is almost certainly the value you want.\n\n` +
      `  In Config.gs:  VERTEX_PROJECT_ID: '${serviceAccount.project_id}',\n\n` +
      `Then clasp push -f and run this again. (Everything above already works — the key is ` +
      `valid and the token exchange succeeded. Only this setting is missing.)`
    );
    return;
  }

  const project = requireConfig_('VERTEX_PROJECT_ID', CONFIG.VERTEX_PROJECT_ID);
  if (serviceAccount.project_id && serviceAccount.project_id !== project) {
    Logger.log(
      `WARNING: CONFIG.VERTEX_PROJECT_ID is "${project}" but the key belongs to ` +
      `"${serviceAccount.project_id}". This works only if the service account was granted ` +
      `Vertex AI User on "${project}" cross-project. Usually it means one of the two is wrong.`
    );
  }

  Logger.log(`Endpoint: ${vertexEndpoint_(project)}`);
  Logger.log('Vertex auth is good.');
}
