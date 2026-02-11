const PB_URL_KEY = "quatorzaine_pb_url";

let pocketbase = null;

let serverFormEl;
let serverStatusEl;
let loginFormEl;
let loginStatusEl;
let signupFormEl;
let signupStatusEl;
let pbUrlEl;

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
  return (pbUrlEl.value || "").trim();
}

function saveConfiguredUrl(url) {
  localStorage.setItem(PB_URL_KEY, url);
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
    setStatus(serverStatusEl, "Serveur enregistre et accessible.", "success");
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
    setStatus(loginStatusEl, "Connexion reussie. Redirection...", "success");
    redirectToPlanner();
  } catch (error) {
    if (isVerificationRelatedError(error)) {
      setStatus(
        loginStatusEl,
        "Compte cree mais email non verifie. Verifiez votre boite mail avant de vous connecter.",
        "error",
      );
      return;
    }

    setStatus(
      loginStatusEl,
      `Echec de connexion: ${extractErrorMessage(error)}`,
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
          "Compte cree. Verifiez votre email puis connectez-vous.",
          "success",
        );
        return;
      }
      throw authError;
    }

    saveConfiguredUrl(url);
    setStatus(signupStatusEl, "Compte cree. Redirection...", "success");
    redirectToPlanner();
  } catch (error) {
    setStatus(
      signupStatusEl,
      `Echec de creation: ${extractErrorMessage(error)}`,
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

  const savedUrl = localStorage.getItem(PB_URL_KEY);
  if (savedUrl) {
    pbUrlEl.value = savedUrl;
  }

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
