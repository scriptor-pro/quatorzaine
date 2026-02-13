(() => {
  const STORAGE_KEY = "quatorzaine_font_variant_v1";
  const ALLOWED = new Set(["a", "b", "c", "d"]);

  const params = new URLSearchParams(window.location.search);
  const paramVariant = String(params.get("font") || "").toLowerCase();

  let variant = "d";
  if (ALLOWED.has(paramVariant)) {
    variant = paramVariant;
    localStorage.setItem(STORAGE_KEY, variant);
  } else {
    const saved = String(localStorage.getItem(STORAGE_KEY) || "").toLowerCase();
    if (ALLOWED.has(saved)) {
      variant = saved;
    }
  }

  document.documentElement.dataset.fontVariant = variant;
})();
