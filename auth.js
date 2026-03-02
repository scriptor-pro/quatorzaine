const PB_URL_KEY = "quatorzaine_pb_url";
const PB_URL_BY_EMAIL_KEY = "quatorzaine_pb_url_by_email_v1";

let pocketbase = null;

let serverFormEl;
let serverStatusEl;
let loginFormEl;
let loginStatusEl;
let signupFormEl;
let signupStatusEl;
let pbUrlEl;
let loginEmailEl;
let signupEmailEl;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function loadPbUrlByEmailMap() {
  const raw = localStorage.getItem(PB_URL_BY_EMAIL_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch (_error) {
    return {};
  }
}

function savePbUrlByEmailMap(map) {
  localStorage.setItem(PB_URL_BY_EMAIL_KEY, JSON.stringify(map));
}

function rememberPbUrlForEmail(email, url) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUrl = String(url || "").trim();
  if (!normalizedEmail || !normalizedUrl) {
    return;
  }

  const map = loadPbUrlByEmailMap();
  map[normalizedEmail] = normalizedUrl;
  savePbUrlByEmailMap(map);
}

function getRememberedPbUrlForEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return "";
  }

  const map = loadPbUrlByEmailMap();
  const saved = map[normalizedEmail];
  return typeof saved === "string" ? saved.trim() : "";
}

function maybeApplyRememberedPbUrlForEmail(email) {
  const remembered = getRememberedPbUrlForEmail(email);
  if (!remembered) {
    return;
  }

  const current = String(pbUrlEl.value || "").trim();
  if (!current || current === localStorage.getItem(PB_URL_KEY)) {
    pbUrlEl.value = remembered;
    setStatus(
      serverStatusEl,
      "URL PocketBase retrouvée pour cet email.",
      "success",
    );
  }
}

function setStatus(target, message, type = "") {
  target.textContent = message;
  target.classList.remove("error", "success");
  if (type) {
    target.classList.add(type);
  }

  const isError = type === "error";
  target.setAttribute("role", isError ? "alert" : "status");
  target.setAttribute("aria-live", isError ? "assertive" : "polite");
}

function extractErrorMessage(error) {
  if (error?.response?.message) {
    return String(error.response.message);
  }
  return String(error?.message || "Erreur inconnue");
}

function isVerificationRelatedError(error) {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("verify") ||
    message.includes("verified") ||
    message.includes("verification")
  );
}

function initPocketBase(url) {
  if (!window.PocketBase) {
    throw new Error("SDK PocketBase introuvable");
  }

  if (!url) {
    throw new Error("URL PocketBase manquante");
  }

  if (!pocketbase || pocketbase.baseURL !== url) {
    pocketbase = new window.PocketBase(url);
    pocketbase.autoCancellation(false);
  }
}

function redirectToPlanner() {
  window.location.href = "quatorzaine.html";
}

function getConfiguredUrl() {
  const current = (pbUrlEl.value || "").trim();
  if (current) {
    return current;
  }

  return localStorage.getItem(PB_URL_KEY) || "";
}

function saveConfiguredUrl(url) {
  localStorage.setItem(PB_URL_KEY, url);
}

function handleUrlInputBlur() {
  const url = (pbUrlEl.value || "").trim();
  if (!url) {
    return;
  }

  saveConfiguredUrl(url);
  setStatus(serverStatusEl, "URL mémorisée sur cet appareil.", "success");
}

async function handleServerSubmit(event) {
  event.preventDefault();
  const url = getConfiguredUrl();
  if (!url) {
    setStatus(serverStatusEl, "Entrez une URL PocketBase valide.", "error");
    return;
  }

  try {
    initPocketBase(url);
    await pocketbase.health.check();
    saveConfiguredUrl(url);
    setStatus(serverStatusEl, "Serveur enregistré et accessible.", "success");
  } catch (error) {
    setStatus(
      serverStatusEl,
      `Serveur inaccessible: ${error.message}`,
      "error",
    );
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const formData = new FormData(loginFormEl);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const url = getConfiguredUrl();

  if (!url) {
    setStatus(loginStatusEl, "Configurez d'abord l'URL PocketBase.", "error");
    return;
  }

  try {
    initPocketBase(url);
    await pocketbase.collection("users").authWithPassword(email, password);
    saveConfiguredUrl(url);
    rememberPbUrlForEmail(email, url);
    setStatus(loginStatusEl, "Connexion réussie. Redirection...", "success");
    redirectToPlanner();
  } catch (error) {
    if (isVerificationRelatedError(error)) {
      setStatus(
        loginStatusEl,
        "Compte créé mais email non vérifié. Vérifiez votre boîte mail avant de vous connecter.",
        "error",
      );
      return;
    }

    setStatus(
      loginStatusEl,
      `Échec de connexion: ${extractErrorMessage(error)}`,
      "error",
    );
  }
}

async function handleSignupSubmit(event) {
  event.preventDefault();
  const formData = new FormData(signupFormEl);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const passwordConfirm = String(formData.get("passwordConfirm") || "");
  const url = getConfiguredUrl();

  if (!url) {
    setStatus(signupStatusEl, "Configurez d'abord l'URL PocketBase.", "error");
    return;
  }

  if (password !== passwordConfirm) {
    setStatus(
      signupStatusEl,
      "Les mots de passe ne correspondent pas.",
      "error",
    );
    return;
  }

  try {
    initPocketBase(url);
    await pocketbase.collection("users").create({
      email,
      password,
      passwordConfirm,
    });

    try {
      await pocketbase.collection("users").authWithPassword(email, password);
    } catch (authError) {
      if (isVerificationRelatedError(authError)) {
        setStatus(
          signupStatusEl,
          "Compte créé. Vérifiez votre email puis connectez-vous.",
          "success",
        );
        return;
      }
      throw authError;
    }

    saveConfiguredUrl(url);
    rememberPbUrlForEmail(email, url);
    setStatus(signupStatusEl, "Compte créé. Redirection...", "success");
    redirectToPlanner();
  } catch (error) {
    setStatus(
      signupStatusEl,
      `Échec de création: ${extractErrorMessage(error)}`,
      "error",
    );
  }
}

function bindAuthPage() {
  serverFormEl = document.getElementById("server-form");
  serverStatusEl = document.getElementById("server-status");
  loginFormEl = document.getElementById("login-form");
  loginStatusEl = document.getElementById("login-status");
  signupFormEl = document.getElementById("signup-form");
  signupStatusEl = document.getElementById("signup-status");
  pbUrlEl = document.getElementById("pb-url");
  loginEmailEl = document.getElementById("login-email");
  signupEmailEl = document.getElementById("signup-email");

  const savedUrl = localStorage.getItem(PB_URL_KEY);
  if (savedUrl) {
    pbUrlEl.value = savedUrl;
    setStatus(
      serverStatusEl,
      "URL PocketBase déjà mémorisée. Vous pouvez vous connecter directement.",
      "success",
    );
  }

  pbUrlEl.addEventListener("blur", handleUrlInputBlur);
  loginEmailEl.addEventListener("blur", () => {
    maybeApplyRememberedPbUrlForEmail(loginEmailEl.value);
  });
  signupEmailEl.addEventListener("blur", () => {
    maybeApplyRememberedPbUrlForEmail(signupEmailEl.value);
  });
  serverFormEl.addEventListener("submit", handleServerSubmit);
  loginFormEl.addEventListener("submit", handleLoginSubmit);
  signupFormEl.addEventListener("submit", handleSignupSubmit);
}

function tryAutoRedirect() {
  const url = localStorage.getItem(PB_URL_KEY);
  if (!url) {
    return;
  }

  try {
    initPocketBase(url);
    if (pocketbase.authStore.isValid) {
      redirectToPlanner();
    }
  } catch (_error) {
    // ignore and stay on auth page
  }
}

bindAuthPage();
tryAutoRedirect();
