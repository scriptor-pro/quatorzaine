const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const MICROSOFT_SCOPE = "openid profile offline_access Calendars.Read";

let cachedAdminToken = "";

function withCors(response, origin) {
  try {
    response.headers.set("Access-Control-Allow-Origin", String(origin || "*"));
  } catch (_error) {
    response.headers.set("Access-Control-Allow-Origin", "*");
  }
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return response;
}

function json(data, status = 200, origin = "*") {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    origin,
  );
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildState(payload, env) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(env.WORKER_STATE_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifyState(rawState, env) {
  const [encodedPayload, signature] = String(rawState || "").split(".");
  if (!encodedPayload || !signature) {
    return null;
  }
  const expected = await hmacSign(env.WORKER_STATE_SECRET, encodedPayload);
  if (expected !== signature) {
    return null;
  }
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  const expiresAt = Number(payload?.expiresAt || 0);
  if (!expiresAt || Date.now() > expiresAt) {
    return null;
  }
  return payload;
}

function pbBase(env) {
  return String(env.PB_URL || "").replace(/\/$/, "");
}

function safeFallbackReturnTo(env) {
  const configured = String(env.APP_BASE_URL || "").trim();
  if (configured) {
    return configured;
  }

  const origin = String(env.APP_ORIGIN || "").trim();
  if (origin) {
    return `${origin.replace(/\/$/, "")}/quatorzaine.html`;
  }

  return "http://localhost:8000/quatorzaine.html";
}

function normalizeReturnTo(rawValue, env) {
  const fallback = safeFallbackReturnTo(env);
  let candidate;

  try {
    candidate = new URL(String(rawValue || fallback || ""));
  } catch (_error) {
    return fallback;
  }

  if (!["http:", "https:"].includes(candidate.protocol)) {
    return fallback;
  }

  const allowedOriginRaw = String(env.APP_ORIGIN || "").trim();
  if (allowedOriginRaw) {
    try {
      const allowedOrigin = new URL(allowedOriginRaw).origin;
      if (candidate.origin !== allowedOrigin) {
        return fallback;
      }
    } catch (_error) {
      return fallback;
    }
  }

  return candidate.toString();
}

async function pbRequest(env, path, init = {}) {
  const response = await fetch(`${pbBase(env)}${path}`, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PocketBase error ${response.status}: ${body}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function getAdminToken(env) {
  if (cachedAdminToken) {
    return cachedAdminToken;
  }

  const result = await pbRequest(env, "/api/admins/auth-with-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: env.PB_ADMIN_EMAIL,
      password: env.PB_ADMIN_PASSWORD,
    }),
  });
  cachedAdminToken = String(result.token || "");
  if (!cachedAdminToken) {
    throw new Error("Admin token manquant");
  }
  return cachedAdminToken;
}

async function pbAdminRequest(env, path, init = {}) {
  const token = await getAdminToken(env);
  return pbRequest(env, path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "Authorization": `Bearer ${token}`,
    },
  });
}

async function getUserFromPbToken(env, pbToken) {
  return pbRequest(env, "/api/collections/users/auth-refresh", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${pbToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

async function listConnections(env, ownerId) {
  const collection = env.PB_CONNECTIONS_COLLECTION || "calendar_connections";
  const filter = ownerId
    ? encodeURIComponent(`owner = "${ownerId}" && status = "active"`)
    : encodeURIComponent('status = "active"');
  const result = await pbAdminRequest(
    env,
    `/api/collections/${collection}/records?page=1&perPage=200&filter=${filter}`,
  );
  return Array.isArray(result?.items) ? result.items : [];
}

async function upsertConnection(env, data) {
  const collection = env.PB_CONNECTIONS_COLLECTION || "calendar_connections";
  const filter = encodeURIComponent(
    `owner = "${data.owner}" && provider = "${data.provider}" && external_account_id = "${data.external_account_id}"`,
  );
  const existing = await pbAdminRequest(
    env,
    `/api/collections/${collection}/records?page=1&perPage=1&filter=${filter}`,
  );
  const body = JSON.stringify(data);
  if (existing.items && existing.items.length > 0) {
    const recordId = existing.items[0].id;
    return pbAdminRequest(env, `/api/collections/${collection}/records/${recordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  return pbAdminRequest(env, `/api/collections/${collection}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function exchangeGoogleCode(env, code, redirectUri) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status}`);
  }
  return response.json();
}

async function refreshGoogleToken(env, refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status}`);
  }
  return response.json();
}

async function fetchGoogleAccountId(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed: ${response.status}`);
  }
  const data = await response.json();
  return String(data.sub || "");
}

async function exchangeMicrosoftCode(env, code, redirectUri) {
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPE,
    }),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token exchange failed: ${response.status}`);
  }
  return response.json();
}

async function refreshMicrosoftToken(env, refreshToken) {
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPE,
    }),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${response.status}`);
  }
  return response.json();
}

async function fetchMicrosoftAccountId(accessToken) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Microsoft profile failed: ${response.status}`);
  }
  const data = await response.json();
  return String(data.id || "");
}

function normalizeGoogleEvent(item) {
  const startRaw = item?.start?.dateTime || item?.start?.date;
  const endRaw = item?.end?.dateTime || item?.end?.date;
  if (!startRaw || !item?.id) {
    return null;
  }

  const isAllDay = !item?.start?.dateTime;
  const startsAt = isAllDay
    ? new Date(`${startRaw}T00:00:00.000Z`).toISOString()
    : new Date(startRaw).toISOString();
  const endsAt = endRaw
    ? (isAllDay ? new Date(`${endRaw}T00:00:00.000Z`).toISOString() : new Date(endRaw).toISOString())
    : new Date(new Date(startsAt).getTime() + 3600000).toISOString();

  return {
    external_event_id: String(item.id),
    title: String(item.summary || "Événement Google"),
    starts_at: startsAt,
    ends_at: endsAt,
    is_all_day: isAllDay,
    location: String(item.location || ""),
    status: String(item.status || "confirmed"),
    source_updated_at: item.updated ? new Date(item.updated).toISOString() : startsAt,
    raw_payload: JSON.stringify(item),
  };
}

function normalizeMicrosoftEvent(item) {
  const startRaw = item?.start?.dateTime;
  const endRaw = item?.end?.dateTime;
  if (!startRaw || !item?.id) {
    return null;
  }

  const startsAt = new Date(startRaw).toISOString();
  const endsAt = endRaw
    ? new Date(endRaw).toISOString()
    : new Date(new Date(startsAt).getTime() + 3600000).toISOString();

  return {
    external_event_id: String(item.id),
    title: String(item.subject || "Événement Outlook"),
    starts_at: startsAt,
    ends_at: endsAt,
    is_all_day: !!item.isAllDay,
    location: String(item.location?.displayName || ""),
    status: String(item.showAs || "busy"),
    source_updated_at: item.lastModifiedDateTime
      ? new Date(item.lastModifiedDateTime).toISOString()
      : startsAt,
    raw_payload: JSON.stringify(item),
  };
}

async function fetchGoogleEvents(accessToken, daysAhead) {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + daysAhead);
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("maxResults", "2500");
  const response = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google events failed: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data.items) ? data.items.map(normalizeGoogleEvent).filter(Boolean) : [];
}

async function fetchMicrosoftEvents(accessToken, daysAhead) {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + daysAhead);
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$top", "1000");
  url.searchParams.set("$orderby", "start/dateTime");
  const response = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Prefer": 'outlook.timezone="UTC"',
    },
  });
  if (!response.ok) {
    throw new Error(`Microsoft events failed: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data.value) ? data.value.map(normalizeMicrosoftEvent).filter(Boolean) : [];
}

async function replaceEventsForConnection(env, connection, events) {
  const collection = env.PB_EXTERNAL_EVENTS_COLLECTION || "external_events";
  const filter = encodeURIComponent(
    `owner = "${connection.owner}" && provider = "${connection.provider}"`,
  );
  const existing = await pbAdminRequest(
    env,
    `/api/collections/${collection}/records?page=1&perPage=500&filter=${filter}`,
  );
  const items = Array.isArray(existing?.items) ? existing.items : [];

  await Promise.all(items.map((item) =>
    pbAdminRequest(env, `/api/collections/${collection}/records/${item.id}`, {
      method: "DELETE",
    })
  ));

  await Promise.all(events.map((event) => {
    const payload = {
      owner: connection.owner,
      provider: connection.provider,
      calendar_id: "primary",
      ...event,
    };
    return pbAdminRequest(env, `/api/collections/${collection}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }));
}

async function refreshConnectionTokenIfNeeded(env, connection) {
  const expiresAt = String(connection.token_expires_at || "");
  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const needsRefresh = !expiresDate || Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() < Date.now() + 120000;
  if (!needsRefresh) {
    return connection;
  }

  const refreshToken = String(connection.refresh_token || "");
  if (!refreshToken) {
    throw new Error(`Refresh token manquant pour ${connection.provider}`);
  }

  const tokenData = connection.provider === "google"
    ? await refreshGoogleToken(env, refreshToken)
    : await refreshMicrosoftToken(env, refreshToken);

  const next = {
    ...connection,
    access_token: String(tokenData.access_token || ""),
    refresh_token: String(tokenData.refresh_token || refreshToken),
    token_expires_at: new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString(),
  };

  await pbAdminRequest(
    env,
    `/api/collections/${env.PB_CONNECTIONS_COLLECTION || "calendar_connections"}/records/${connection.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: next.access_token,
        refresh_token: next.refresh_token,
        token_expires_at: next.token_expires_at,
        status: "active",
        last_error: "",
      }),
    },
  );

  return next;
}

async function syncConnection(env, connection, daysAhead) {
  const resolved = await refreshConnectionTokenIfNeeded(env, connection);
  const events = resolved.provider === "google"
    ? await fetchGoogleEvents(resolved.access_token, daysAhead)
    : await fetchMicrosoftEvents(resolved.access_token, daysAhead);

  await replaceEventsForConnection(env, resolved, events);

  await pbAdminRequest(
    env,
    `/api/collections/${env.PB_CONNECTIONS_COLLECTION || "calendar_connections"}/records/${resolved.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        last_sync_at: new Date().toISOString(),
        last_error: "",
        status: "active",
      }),
    },
  );

  return events.length;
}

async function handleOAuthStart(request, env, provider, origin) {
  const authHeader = request.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const body = await request.json().catch(() => ({}));
  const pbToken = bearerToken;
  const returnToRaw = String(body?.returnTo || "");
  const returnTo = normalizeReturnTo(returnToRaw, env);

  if (!pbToken) {
    return json({ error: "Token PocketBase manquant" }, 400, origin);
  }

  if (!env.WORKER_STATE_SECRET) {
    return json({ error: "WORKER_STATE_SECRET manquant" }, 500, origin);
  }

  if (provider === "google" && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
    return json({ error: "Secrets Google manquants" }, 500, origin);
  }

  if (provider === "microsoft" && (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET)) {
    return json({ error: "Secrets Microsoft manquants" }, 500, origin);
  }

  const userInfo = await getUserFromPbToken(env, pbToken);
  const ownerId = String(userInfo?.record?.id || "");
  if (!ownerId) {
    return json({ error: "Utilisateur PocketBase invalide" }, 401, origin);
  }

  const callbackPath = provider === "google" ? "/oauth/google/callback" : "/oauth/microsoft/callback";
  const callbackUrl = `${new URL(request.url).origin}${callbackPath}`;

  const state = await buildState({
    ownerId,
    provider,
    returnTo,
    expiresAt: Date.now() + 5 * 60 * 1000,
  }, env);

  if (provider === "google") {
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_SCOPE);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);
    return json({ redirectUrl: authUrl.toString() }, 200, origin);
  }

  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", MICROSOFT_SCOPE);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("state", state);
  return json({ redirectUrl: authUrl.toString() }, 200, origin);
}

async function handleOAuthCallback(request, env, provider) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "");
  const stateRaw = String(url.searchParams.get("state") || "");
  if (!code || !stateRaw) {
    return new Response("callback invalide", { status: 400 });
  }

  const state = await verifyState(stateRaw, env);
  if (!state || state.provider !== provider) {
    return new Response("state invalide ou expiré", { status: 400 });
  }

  const callbackPath = provider === "google" ? "/oauth/google/callback" : "/oauth/microsoft/callback";
  const callbackUrl = `${new URL(request.url).origin}${callbackPath}`;

  const tokenData = provider === "google"
    ? await exchangeGoogleCode(env, code, callbackUrl)
    : await exchangeMicrosoftCode(env, code, callbackUrl);

  const accessToken = String(tokenData.access_token || "");
  const refreshToken = String(tokenData.refresh_token || "");
  if (!accessToken) {
    return new Response("Access token absent", { status: 500 });
  }

  const externalAccountId = provider === "google"
    ? await fetchGoogleAccountId(accessToken)
    : await fetchMicrosoftAccountId(accessToken);

  await upsertConnection(env, {
    owner: state.ownerId,
    provider,
    external_account_id: externalAccountId,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString(),
    scopes: String(tokenData.scope || (provider === "google" ? GOOGLE_SCOPE : MICROSOFT_SCOPE)),
    status: "active",
    last_error: "",
    last_sync_at: "",
  });

  const redirect = new URL(normalizeReturnTo(state.returnTo, env));
  redirect.searchParams.set("calendar_connected", provider);
  return Response.redirect(redirect.toString(), 302);
}

async function handleSyncSelf(request, env, origin) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return json({ error: "Authorization manquante" }, 401, origin);
  }

  const user = await getUserFromPbToken(env, token);
  const ownerId = String(user?.record?.id || "");
  if (!ownerId) {
    return json({ error: "Token PocketBase invalide" }, 401, origin);
  }

  const body = await request.json().catch(() => ({}));
  const daysAhead = Math.max(1, Math.min(90, Number(body?.daysAhead || 30)));
  const connections = await listConnections(env, ownerId);

  let synced = 0;
  for (const connection of connections) {
    try {
      synced += await syncConnection(env, connection, daysAhead);
    } catch (error) {
      await pbAdminRequest(
        env,
        `/api/collections/${env.PB_CONNECTIONS_COLLECTION || "calendar_connections"}/records/${connection.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            last_error: String(error.message || "sync failed"),
          }),
        },
      );
    }
  }

  return json({ syncedEvents: synced, connections: connections.length }, 200, origin);
}

async function scheduledSync(env) {
  const connections = await listConnections(env, "");
  for (const connection of connections) {
    try {
      await syncConnection(env, connection, 30);
    } catch (error) {
      await pbAdminRequest(
        env,
        `/api/collections/${env.PB_CONNECTIONS_COLLECTION || "calendar_connections"}/records/${connection.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            last_error: String(error.message || "scheduled sync failed"),
          }),
        },
      );
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const origin = env.APP_ORIGIN || "*";

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), origin);
      }

      if (request.method === "GET" && path === "/health") {
        return json({ ok: true, service: "calendar-worker" }, 200, origin);
      }

      if (request.method === "POST" && path === "/oauth/google/start") {
        return await handleOAuthStart(request, env, "google", origin);
      }
      if (request.method === "POST" && path === "/oauth/microsoft/start") {
        return await handleOAuthStart(request, env, "microsoft", origin);
      }
      if (request.method === "GET" && path === "/oauth/google/callback") {
        return await handleOAuthCallback(request, env, "google");
      }
      if (request.method === "GET" && path === "/oauth/microsoft/callback") {
        return await handleOAuthCallback(request, env, "microsoft");
      }
      if (request.method === "POST" && path === "/sync/self") {
        return await handleSyncSelf(request, env, origin);
      }

      return json({ error: "Route introuvable" }, 404, origin);
    } catch (error) {
      console.error("Worker fetch error", {
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
        method: request.method,
        url: request.url,
      });
      return new Response(
        JSON.stringify({ error: String(error?.message || "Unexpected error") }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledSync(env));
  },
};
