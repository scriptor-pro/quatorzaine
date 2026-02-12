const STORAGE_KEY = "quatorzaine_schedule_v1";
const RECURRING_STORAGE_KEY = "quatorzaine_recurring_v1";
const PB_URL_KEY = "quatorzaine_pb_url";
const PB_COLLECTION = "planner_snapshots";
const DAY_COUNT = 14;
const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

let schedule = [];
let recurringRules = [];
let pocketbase = null;
let cloudSaveTimer = null;

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildBaseSchedule() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = [];

  for (let i = 0; i < DAY_COUNT; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    days.push({
      key: dayKey(date),
      dayName: DAY_NAMES[date.getDay()],
      tasks: [],
      appointments: [],
    });
  }

  return days;
}

function normalizeSchedule(raw) {
  const base = buildBaseSchedule();
  if (!Array.isArray(raw)) {
    return base;
  }

  const byKey = new Map(raw.map((day) => [day.key, day]));
  return base.map((day) => {
    const previous = byKey.get(day.key);
    if (!previous) {
      return day;
    }

    return {
      ...day,
      tasks: Array.isArray(previous.tasks) ? previous.tasks : [],
      appointments: Array.isArray(previous.appointments)
        ? previous.appointments
        : [],
    };
  });
}

function normalizeRecurringRules(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((rule) => {
      if (!rule || typeof rule !== "object") {
        return null;
      }

      const frequency =
        rule.frequency === "daily" || rule.frequency === "weekly"
          ? rule.frequency
          : null;
      if (!frequency) {
        return null;
      }

      const weekdays = Array.isArray(rule.weekdays)
        ? rule.weekdays
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
        : [];

      const normalized = {
        id: typeof rule.id === "string" && rule.id ? rule.id : makeId(),
        text: String(rule.text || "").trim(),
        time: String(rule.time || "").trim(),
        durationMinutes: Math.max(1, Math.round(Number(rule.durationMinutes) || 0)),
        frequency,
        startDate: String(rule.startDate || "").trim(),
        endDate: String(rule.endDate || "").trim(),
        weekdays,
      };

      if (!normalized.text || !normalized.time || !normalized.startDate) {
        return null;
      }
      if (normalized.frequency === "weekly" && normalized.weekdays.length === 0) {
        return null;
      }

      return normalized;
    })
    .filter(Boolean);
}

function loadSchedule() {
  const savedRaw = localStorage.getItem(STORAGE_KEY);
  if (!savedRaw) {
    return buildBaseSchedule();
  }

  try {
    return normalizeSchedule(JSON.parse(savedRaw));
  } catch (_error) {
    return buildBaseSchedule();
  }
}

function saveSchedule() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  queueCloudSave();
}

function loadRecurringRules() {
  const savedRaw = localStorage.getItem(RECURRING_STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    return normalizeRecurringRules(JSON.parse(savedRaw));
  } catch (_error) {
    return [];
  }
}

function saveRecurringRules() {
  localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
  queueCloudSave();
}

function serializeSnapshot() {
  return JSON.stringify({
    schedule,
    recurringRules,
  });
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById("appointment-status");
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b2452f" : "#6f6255";
}

function initPocketBase(url) {
  if (!window.PocketBase || !url) {
    return;
  }

  if (!pocketbase || pocketbase.baseURL !== url) {
    pocketbase = new window.PocketBase(url);
    pocketbase.autoCancellation(false);
  }
}

function isCloudConnected() {
  return !!(pocketbase && pocketbase.authStore && pocketbase.authStore.isValid);
}

async function pushSnapshotToCloud() {
  if (!isCloudConnected()) {
    return;
  }

  try {
    const userId = pocketbase.authStore.model.id;
    const list = await pocketbase.collection(PB_COLLECTION).getList(1, 1, {
      filter: `owner = "${userId}"`,
      sort: "-updated",
    });

    const payload = { schedule: serializeSnapshot() };
    if (list.items.length > 0) {
      await pocketbase.collection(PB_COLLECTION).update(list.items[0].id, payload);
    } else {
      await pocketbase.collection(PB_COLLECTION).create({
        owner: userId,
        ...payload,
      });
    }
  } catch (_error) {
    return;
  }
}

function queueCloudSave() {
  if (!isCloudConnected()) {
    return;
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
  }

  cloudSaveTimer = setTimeout(() => {
    pushSnapshotToCloud();
  }, 500);
}

function getTodayDateValue() {
  return dayKey(new Date());
}

function formatRule(rule) {
  if (rule.frequency === "daily") {
    return `Tous les jours a ${rule.time} (${rule.durationMinutes} min)`;
  }

  const labels = rule.weekdays
    .slice()
    .sort((a, b) => a - b)
    .map((index) => DAY_NAMES[index].slice(0, 3));
  return `${labels.join(", ")} a ${rule.time} (${rule.durationMinutes} min)`;
}

function renderRulesList() {
  const listEl = document.getElementById("rules-list");
  listEl.innerHTML = "";

  if (recurringRules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-item";
    empty.textContent = "Aucun rendez-vous recurrent.";
    listEl.append(empty);
    return;
  }

  recurringRules.forEach((rule) => {
    const item = document.createElement("li");
    item.className = "rule-item";

    const text = document.createElement("div");
    text.className = "rule-text";

    const title = document.createElement("strong");
    title.textContent = rule.text;

    const subtitle = document.createElement("span");
    const endDateLabel = rule.endDate ? `, jusqu'au ${rule.endDate}` : "";
    subtitle.textContent = `${formatRule(rule)}, depuis ${rule.startDate}${endDateLabel}`;

    text.append(title, subtitle);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "rule-delete";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      recurringRules = recurringRules.filter((candidate) => candidate.id !== rule.id);
      saveRecurringRules();
      renderRulesList();
      setStatus("Rendez-vous recurrent supprime.");
    });

    item.append(text, deleteBtn);
    listEl.append(item);
  });
}

function updateModeVisibility() {
  const mode = document.getElementById("appointment-mode").value;
  const frequency = document.getElementById("recurrence-frequency").value;

  const oneShotOnlyEls = document.querySelectorAll(".one-shot-only");
  const recurringOnlyEls = document.querySelectorAll(".recurring-only");
  const weekdayPickerEl = document.querySelector(".weekday-picker");
  const dateEl = document.getElementById("appointment-date");
  const startDateEl = document.getElementById("appointment-start-date");

  if (mode === "one-shot") {
    oneShotOnlyEls.forEach((el) => el.classList.remove("hidden"));
    recurringOnlyEls.forEach((el) => el.classList.add("hidden"));
    dateEl.required = true;
    startDateEl.required = false;
    return;
  }

  oneShotOnlyEls.forEach((el) => el.classList.add("hidden"));
  recurringOnlyEls.forEach((el) => el.classList.remove("hidden"));
  dateEl.required = false;
  startDateEl.required = true;

  if (frequency === "weekly") {
    weekdayPickerEl.classList.remove("hidden");
  } else {
    weekdayPickerEl.classList.add("hidden");
  }
}

function bindForm() {
  const formEl = document.getElementById("appointment-form");
  const modeEl = document.getElementById("appointment-mode");
  const frequencyEl = document.getElementById("recurrence-frequency");
  const startDateEl = document.getElementById("appointment-start-date");
  const dateEl = document.getElementById("appointment-date");

  const today = getTodayDateValue();
  startDateEl.value = today;
  dateEl.value = today;

  modeEl.addEventListener("change", updateModeVisibility);
  frequencyEl.addEventListener("change", updateModeVisibility);
  updateModeVisibility();

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(formEl);
    const text = String(formData.get("text") || "").trim();
    const time = String(formData.get("time") || "").trim();
    const durationMinutes = Number(formData.get("duration") || 0);
    const mode = String(formData.get("mode") || "one-shot");
    const startDate = String(formData.get("startDate") || "").trim();

    if (!text || !time || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      setStatus("Formulaire incomplet ou invalide.", true);
      return;
    }

    if (mode === "one-shot") {
      const date = String(formData.get("date") || "").trim();
      const day = schedule.find((candidate) => candidate.key === date);
      if (!day) {
        setStatus(
          "Date hors quatorzaine. Choisissez un jour dans les 14 prochains jours.",
          true,
        );
        return;
      }

      day.appointments.push({
        id: makeId(),
        time,
        text,
        durationMinutes: Math.round(durationMinutes),
      });
      saveSchedule();
      setStatus("Rendez-vous ponctuel enregistre.");
      formEl.reset();
      startDateEl.value = today;
      dateEl.value = today;
      updateModeVisibility();
      return;
    }

    const frequency = String(formData.get("frequency") || "daily");
    const endDate = String(formData.get("endDate") || "").trim();
    const weekdays = formData
      .getAll("weekday")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

    if (!startDate) {
      setStatus("Choisissez une date de debut.", true);
      return;
    }
    if (endDate && endDate < startDate) {
      setStatus("La date de fin doit etre apres la date de debut.", true);
      return;
    }
    if (frequency === "weekly" && weekdays.length === 0) {
      setStatus("Choisissez au moins un jour pour la recurrence hebdomadaire.", true);
      return;
    }

    recurringRules.push({
      id: makeId(),
      text,
      time,
      durationMinutes: Math.round(durationMinutes),
      frequency: frequency === "weekly" ? "weekly" : "daily",
      startDate,
      endDate,
      weekdays,
    });
    saveRecurringRules();
    renderRulesList();
    setStatus("Rendez-vous recurrent enregistre.");

    formEl.reset();
    modeEl.value = "one-shot";
    startDateEl.value = today;
    dateEl.value = today;
    updateModeVisibility();
  });
}

function initApp() {
  schedule = loadSchedule();
  recurringRules = loadRecurringRules();
  initPocketBase(localStorage.getItem(PB_URL_KEY));
  bindForm();
  renderRulesList();
}

initApp();
