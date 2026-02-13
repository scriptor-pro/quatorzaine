const STORAGE_KEY = "quatorzaine_schedule_v1";
const RECURRING_STORAGE_KEY = "quatorzaine_recurring_v1";
const DETACHED_APPOINTMENTS_STORAGE_KEY = "quatorzaine_detached_appointments_v1";
const RECURRING_TASK_STORAGE_KEY = "quatorzaine_recurring_tasks_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
const HISTORY_MAX_DAYS = 3650;
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

const PB_URL_KEY = "quatorzaine_pb_url";
const PB_COLLECTION = "planner_snapshots";

let schedule = [];
let recurringRules = [];
let detachedAppointments = [];
let recurringTaskRules = [];
let history = [];
let pocketbase = null;
let cloudSaveTimer = null;

let cloudStatusEl;
let cloudPullBtnEl;
let cloudPushBtnEl;
let plannerLogoutBtnEl;
let recurringTaskFormEl;
let recurringTaskStatusEl;
let recurringTaskListEl;

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToDate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.split("-");
  if (parts.length !== 3) {
    return null;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function shiftDateByDays(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  shifted.setHours(0, 0, 0, 0);
  return shifted;
}

function buildBaseSchedule() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = [];

  for (let i = 0; i < DAY_COUNT; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const weekdayIndex = date.getDay();
    days.push({
      key: dayKey(date),
      dayName: DAY_NAMES[weekdayIndex],
      weekdayIndex,
      dayOffset: i,
      dateLabel: String(date.getDate()),
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

  const normalized = base.map((day) => {
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

  const normalizedByKey = new Map(normalized.map((day) => [day.key, day]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  raw.forEach((savedDay) => {
    if (!savedDay || !Array.isArray(savedDay.tasks)) {
      return;
    }

    const sourceDate = dayKeyToDate(savedDay.key);
    if (!sourceDate || sourceDate >= today) {
      return;
    }

    savedDay.tasks.forEach((task) => {
      if (!task || task.done || task.isRecurringOccurrence) {
        return;
      }

      let targetDate = shiftDateByDays(sourceDate, 1);
      while (targetDate < today) {
        targetDate = shiftDateByDays(targetDate, 1);
      }

      const targetKey = dayKey(targetDate);
      const targetDay = normalizedByKey.get(targetKey);
      if (!targetDay) {
        return;
      }

      const alreadyExists = targetDay.tasks.some(
        (candidate) => candidate.id === task.id,
      );
      if (!alreadyExists) {
        targetDay.tasks.unshift({ ...task, done: false });
      }
    });
  });

  return normalized;
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

      return {
        id: typeof rule.id === "string" && rule.id ? rule.id : makeId(),
        text: String(rule.text || "").trim(),
        time: String(rule.time || "").trim(),
        durationMinutes: Math.max(1, Math.round(Number(rule.durationMinutes) || 0)),
        frequency,
        startDate: String(rule.startDate || "").trim(),
        endDate: String(rule.endDate || "").trim(),
        weekdays,
      };
    })
    .filter((rule) => {
      if (!rule) {
        return false;
      }
      if (!rule.text || !rule.time || !rule.startDate) {
        return false;
      }
      if (rule.frequency === "weekly" && rule.weekdays.length === 0) {
        return false;
      }
      return true;
    });
}

function normalizeRecurringTaskRules(raw) {
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
        frequency,
        startDate: String(rule.startDate || "").trim(),
        endDate: String(rule.endDate || "").trim(),
        weekdays,
      };

      if (!normalized.text || !normalized.startDate) {
        return null;
      }
      if (normalized.frequency === "weekly" && normalized.weekdays.length === 0) {
        return null;
      }

      return normalized;
    })
    .filter(Boolean);
}

function taskRuleAppliesToDay(rule, day) {
  const dayDate = dayKeyToDate(day.key);
  const startDate = dayKeyToDate(rule.startDate);
  const endDate = rule.endDate ? dayKeyToDate(rule.endDate) : null;
  if (!dayDate || !startDate) {
    return false;
  }
  if (dayDate < startDate) {
    return false;
  }
  if (endDate && dayDate > endDate) {
    return false;
  }

  if (rule.frequency === "daily") {
    return true;
  }

  return rule.weekdays.includes(day.weekdayIndex);
}

function recurringTaskId(ruleId, dayKeyValue) {
  return `rec-task-${ruleId}-${dayKeyValue}`;
}

function syncRecurringTasksIntoSchedule(days, rules) {
  if (!Array.isArray(days)) {
    return;
  }

  const normalizedRules = normalizeRecurringTaskRules(rules);
  const ruleById = new Map(normalizedRules.map((rule) => [rule.id, rule]));

  days.forEach((day) => {
    const tasks = Array.isArray(day.tasks) ? day.tasks : [];

    let nextTasks = tasks.filter((task) => {
      if (!task || !task.isRecurringOccurrence) {
        return true;
      }

      const rule = ruleById.get(task.recurringRuleId);
      if (!rule) {
        return false;
      }

      if (task.recurringForDay !== day.key) {
        return false;
      }

      return taskRuleAppliesToDay(rule, day);
    });

    normalizedRules.forEach((rule) => {
      if (!taskRuleAppliesToDay(rule, day)) {
        return;
      }

      const existing = nextTasks.find(
        (task) =>
          task &&
          task.isRecurringOccurrence &&
          task.recurringRuleId === rule.id &&
          task.recurringForDay === day.key,
      );

      if (existing) {
        existing.text = rule.text;
        existing.id = recurringTaskId(rule.id, day.key);
        return;
      }

      nextTasks.unshift({
        id: recurringTaskId(rule.id, day.key),
        text: rule.text,
        done: false,
        isRecurringOccurrence: true,
        recurringRuleId: rule.id,
        recurringForDay: day.key,
      });
    });

    day.tasks = nextTasks;
  });
}

function normalizeDetachedAppointments(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((appointment) => {
      if (!appointment || typeof appointment !== "object") {
        return null;
      }

      const date = String(appointment.date || "").trim();
      if (!dayKeyToDate(date)) {
        return null;
      }

      const time = String(appointment.time || "").trim();
      const text = String(appointment.text || "").trim();
      const durationMinutes = Math.round(Number(appointment.durationMinutes) || 0);
      if (!time || !text || durationMinutes <= 0) {
        return null;
      }

      return {
        id:
          typeof appointment.id === "string" && appointment.id
            ? appointment.id
            : makeId(),
        date,
        time,
        text,
        durationMinutes,
      };
    })
    .filter(Boolean);
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((day) => {
      if (!day || typeof day !== "object") {
        return null;
      }

      const key = String(day.key || "").trim();
      const keyDate = dayKeyToDate(key);
      if (!keyDate) {
        return null;
      }

      const weekdayIndex = Number(day.weekdayIndex);
      const tasks = Array.isArray(day.tasks)
        ? day.tasks.map((task) => ({
            id: typeof task?.id === "string" && task.id ? task.id : makeId(),
            text: String(task?.text || ""),
            done: !!task?.done,
          }))
        : [];

      return {
        key,
        weekdayIndex:
          Number.isInteger(weekdayIndex) && weekdayIndex >= 0 && weekdayIndex <= 6
            ? weekdayIndex
            : keyDate.getDay(),
        tasks,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function mergeScheduleIntoHistory(previousHistory, currentSchedule) {
  const byKey = new Map(
    normalizeHistory(previousHistory).map((day) => [day.key, day]),
  );

  currentSchedule.forEach((day) => {
    const key = String(day.key || "").trim();
    const keyDate = dayKeyToDate(key);
    if (!keyDate) {
      return;
    }

    byKey.set(key, {
      key,
      weekdayIndex:
        Number.isInteger(day.weekdayIndex) && day.weekdayIndex >= 0 && day.weekdayIndex <= 6
          ? day.weekdayIndex
          : keyDate.getDay(),
      tasks: Array.isArray(day.tasks)
        ? day.tasks.map((task) => ({
            id: typeof task?.id === "string" && task.id ? task.id : makeId(),
            text: String(task?.text || ""),
            done: !!task?.done,
          }))
        : [],
    });
  });

  const merged = Array.from(byKey.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  if (merged.length <= HISTORY_MAX_DAYS) {
    return merged;
  }

  return merged.slice(merged.length - HISTORY_MAX_DAYS);
}

function parseCloudSnapshot(rawValue) {
  if (typeof rawValue === "string") {
    const text = rawValue.trim();
    if (!text) {
      return {
        schedule: [],
        recurringRules: [],
        detachedAppointments: [],
        recurringTaskRules: [],
        history: [],
      };
    }

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") {
        try {
          return parseCloudSnapshot(parsed);
        } catch (_doubleEncodedError) {
          return {
            schedule: [],
            recurringRules: [],
            detachedAppointments: [],
            recurringTaskRules: [],
            history: [],
          };
        }
      }
      return parseCloudSnapshot(parsed);
    } catch (_invalidJsonError) {
      return {
        schedule: [],
        recurringRules: [],
        detachedAppointments: [],
        recurringTaskRules: [],
        history: [],
      };
    }
  }

  if (Array.isArray(rawValue)) {
    return {
      schedule: rawValue,
      recurringRules: [],
      detachedAppointments: [],
      recurringTaskRules: [],
      history: [],
    };
  }

  if (rawValue && typeof rawValue === "object") {
    return {
      schedule: Array.isArray(rawValue.schedule) ? rawValue.schedule : [],
      recurringRules: Array.isArray(rawValue.recurringRules)
        ? rawValue.recurringRules
        : [],
      detachedAppointments: Array.isArray(rawValue.detachedAppointments)
        ? rawValue.detachedAppointments
        : [],
      recurringTaskRules: Array.isArray(rawValue.recurringTaskRules)
        ? rawValue.recurringTaskRules
        : [],
      history: Array.isArray(rawValue.history) ? rawValue.history : [],
    };
  }

  return {
    schedule: [],
    recurringRules: [],
    detachedAppointments: [],
    recurringTaskRules: [],
    history: [],
  };
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

function loadRecurringTaskRules() {
  const savedRaw = localStorage.getItem(RECURRING_TASK_STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    return normalizeRecurringTaskRules(JSON.parse(savedRaw));
  } catch (_error) {
    return [];
  }
}

function loadDetachedAppointments() {
  const savedRaw = localStorage.getItem(DETACHED_APPOINTMENTS_STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    return normalizeDetachedAppointments(JSON.parse(savedRaw));
  } catch (_error) {
    return [];
  }
}

function loadHistory() {
  const savedRaw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    return normalizeHistory(JSON.parse(savedRaw));
  } catch (_error) {
    return [];
  }
}

function saveSchedule() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  history = mergeScheduleIntoHistory(history, schedule);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  queueCloudSave();
}

function saveRecurringRules() {
  localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
  queueCloudSave();
}

function saveRecurringTaskRules() {
  localStorage.setItem(
    RECURRING_TASK_STORAGE_KEY,
    JSON.stringify(recurringTaskRules),
  );
  queueCloudSave();
}

function saveDetachedAppointments() {
  localStorage.setItem(
    DETACHED_APPOINTMENTS_STORAGE_KEY,
    JSON.stringify(detachedAppointments),
  );
  queueCloudSave();
}

function serializeSnapshot() {
  return JSON.stringify({
    schedule,
    recurringRules,
    detachedAppointments,
    recurringTaskRules,
    history,
  });
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function parseTimeToMinutes(value) {
  if (typeof value !== "string" || !value.includes(":")) {
    return null;
  }

  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function minutesToTimeLabel(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) {
    return "--:--";
  }
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minutes = String(normalized % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDuration(durationMinutes) {
  const value = Number(durationMinutes);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} h`;
  }

  return `${value} min`;
}

function isReducedMotionPreferred() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function launchConfetti() {
  if (!window.confetti || isReducedMotionPreferred()) {
    return;
  }
  window.confetti({
    particleCount: 60,
    spread: 65,
    origin: { y: 0.7 },
  });
}

function setCloudStatus(message, isError = false) {
  if (!cloudStatusEl) {
    return;
  }
  cloudStatusEl.textContent = message;
  cloudStatusEl.style.color = isError ? "#b2452f" : "#6f6255";
}

function isCloudConnected() {
  return !!(pocketbase && pocketbase.authStore && pocketbase.authStore.isValid);
}

function updateCloudButtons() {
  const connected = isCloudConnected();
  if (cloudPullBtnEl) {
    cloudPullBtnEl.disabled = !connected;
  }
  if (cloudPushBtnEl) {
    cloudPushBtnEl.disabled = !connected;
  }
  if (plannerLogoutBtnEl) {
    plannerLogoutBtnEl.disabled = !connected;
  }
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

async function getSnapshotRecord(createIfMissing = false) {
  if (!isCloudConnected()) {
    throw new Error("Non connecté à PocketBase");
  }

  const userId = pocketbase.authStore.model.id;
  const list = await pocketbase.collection(PB_COLLECTION).getList(1, 1, {
    filter: `owner = "${userId}"`,
    sort: "-updated",
  });

  if (list.items.length > 0) {
    return list.items[0];
  }

  if (!createIfMissing) {
    return null;
  }

  return pocketbase.collection(PB_COLLECTION).create({
    owner: userId,
    schedule: serializeSnapshot(),
  });
}

async function pullFromCloud(silent = false) {
  if (!isCloudConnected()) {
    setCloudStatus("Connectez-vous d'abord à PocketBase.", true);
    return;
  }

  try {
    const record = await getSnapshotRecord(false);
    if (!record) {
      if (!silent) {
        setCloudStatus("Aucun snapshot cloud trouvé. Rien à télécharger.");
      }
      return;
    }

    const snapshot = parseCloudSnapshot(record.schedule);
    schedule = normalizeSchedule(snapshot.schedule);
    recurringRules = normalizeRecurringRules(snapshot.recurringRules);
    detachedAppointments = normalizeDetachedAppointments(
      snapshot.detachedAppointments,
    );
    recurringTaskRules = normalizeRecurringTaskRules(snapshot.recurringTaskRules);
    syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
    history = mergeScheduleIntoHistory(normalizeHistory(snapshot.history), schedule);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
    localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
    localStorage.setItem(
      DETACHED_APPOINTMENTS_STORAGE_KEY,
      JSON.stringify(detachedAppointments),
    );
    localStorage.setItem(
      RECURRING_TASK_STORAGE_KEY,
      JSON.stringify(recurringTaskRules),
    );
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    renderRecurringTaskRules();
    render();

    if (!silent) {
      setCloudStatus("Données cloud téléchargées vers cet appareil.");
    }
  } catch (error) {
    setCloudStatus(`Échec du téléchargement cloud: ${error.message}`, true);
  }
}

async function pushToCloud(silent = false) {
  if (!isCloudConnected()) {
    if (!silent) {
      setCloudStatus("Connectez-vous d'abord à PocketBase.", true);
    }
    return;
  }

  try {
    const record = await getSnapshotRecord(false);
    const payload = { schedule: serializeSnapshot() };

    if (record) {
      await pocketbase.collection(PB_COLLECTION).update(record.id, payload);
    } else {
      await pocketbase.collection(PB_COLLECTION).create({
        owner: pocketbase.authStore.model.id,
        ...payload,
      });
    }

    if (!silent) {
      setCloudStatus("Données locales envoyées vers PocketBase.");
    }
  } catch (error) {
    setCloudStatus(`Échec de l'envoi cloud: ${error.message}`, true);
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
    pushToCloud(true);
  }, 700);
}

function formatRecurringTaskRule(rule) {
  if (rule.frequency === "daily") {
    return `Tous les jours depuis ${rule.startDate}${
      rule.endDate ? ` jusqu'au ${rule.endDate}` : ""
    }`;
  }

  const labels = rule.weekdays
    .slice()
    .sort((a, b) => a - b)
    .map((index) => DAY_NAMES[index].slice(0, 3));
  return `${labels.join(", ")} depuis ${rule.startDate}${
    rule.endDate ? ` jusqu'au ${rule.endDate}` : ""
  }`;
}

function setRecurringTaskStatus(message, isError = false) {
  if (!recurringTaskStatusEl) {
    return;
  }

  recurringTaskStatusEl.textContent = message;
  recurringTaskStatusEl.style.color = isError ? "#b2452f" : "#6f6255";
}

function renderRecurringTaskRules() {
  if (!recurringTaskListEl) {
    return;
  }

  recurringTaskListEl.innerHTML = "";

  if (recurringTaskRules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "recurring-task-item empty";
    empty.textContent = "Aucune tâche récurrente active.";
    recurringTaskListEl.append(empty);
    return;
  }

  recurringTaskRules.forEach((rule) => {
    const item = document.createElement("li");
    item.className = "recurring-task-item";

    const details = document.createElement("div");
    details.className = "recurring-task-details";

    const title = document.createElement("strong");
    title.textContent = rule.text;

    const subtitle = document.createElement("span");
    subtitle.textContent = formatRecurringTaskRule(rule);

    details.append(title, subtitle);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      recurringTaskRules = recurringTaskRules.filter(
        (candidate) => candidate.id !== rule.id,
      );
      syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
      saveRecurringTaskRules();
      saveSchedule();
      renderRecurringTaskRules();
      render();
      setRecurringTaskStatus("Tâche récurrente supprimée.");
    });

    item.append(details, deleteBtn);
    recurringTaskListEl.append(item);
  });
}

function updateRecurringTaskFrequencyVisibility() {
  const frequencyEl = document.getElementById("recurring-task-frequency");
  const weekdaysEl = document.getElementById("recurring-task-weekdays");
  const weekdayInputs = weekdaysEl.querySelectorAll('input[name="weekday"]');

  if (frequencyEl.value === "weekly") {
    weekdaysEl.classList.remove("hidden");
    weekdayInputs.forEach((input) => {
      input.disabled = false;
    });
    return;
  }

  weekdaysEl.classList.add("hidden");
  weekdayInputs.forEach((input) => {
    input.checked = false;
    input.disabled = true;
  });
}

function bindRecurringTaskControls() {
  recurringTaskFormEl = document.getElementById("recurring-task-form");
  recurringTaskStatusEl = document.getElementById("recurring-task-status");
  recurringTaskListEl = document.getElementById("recurring-task-list");
  if (!recurringTaskFormEl || !recurringTaskStatusEl || !recurringTaskListEl) {
    return;
  }

  const frequencyEl = document.getElementById("recurring-task-frequency");
  const startDateEl = document.getElementById("recurring-task-start");
  const endDateEl = document.getElementById("recurring-task-end");
  if (!frequencyEl || !startDateEl || !endDateEl) {
    return;
  }

  const todayKey = dayKey(new Date());
  startDateEl.value = todayKey;
  startDateEl.min = todayKey;
  endDateEl.min = todayKey;

  frequencyEl.addEventListener("change", updateRecurringTaskFrequencyVisibility);
  startDateEl.addEventListener("change", () => {
    const start = String(startDateEl.value || "").trim();
    endDateEl.min = start || todayKey;
    if (endDateEl.value && endDateEl.value < endDateEl.min) {
      endDateEl.value = endDateEl.min;
    }
  });

  recurringTaskFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(recurringTaskFormEl);
    const text = String(formData.get("text") || "").trim();
    const frequency = String(formData.get("frequency") || "daily");
    const startDate = String(formData.get("startDate") || "").trim();
    const endDate = String(formData.get("endDate") || "").trim();
    const weekdays = formData
      .getAll("weekday")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

    if (!text || !startDate) {
      setRecurringTaskStatus("Renseignez le texte et la date de début.", true);
      return;
    }

    if (endDate && endDate < startDate) {
      setRecurringTaskStatus("La date de fin doit être après la date de début.", true);
      return;
    }

    if (frequency === "weekly" && weekdays.length === 0) {
      const startDateObj = dayKeyToDate(startDate);
      if (startDateObj) {
        weekdays.push(startDateObj.getDay());
      }
    }

    if (frequency === "weekly" && weekdays.length === 0) {
      setRecurringTaskStatus(
        "Choisissez au moins un jour pour la récurrence hebdomadaire.",
        true,
      );
      return;
    }

    recurringTaskRules.push({
      id: makeId(),
      text,
      frequency: frequency === "weekly" ? "weekly" : "daily",
      startDate,
      endDate,
      weekdays,
    });

    syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
    saveRecurringTaskRules();
    saveSchedule();
    recurringTaskFormEl.reset();
    startDateEl.value = todayKey;
    endDateEl.min = todayKey;
    updateRecurringTaskFrequencyVisibility();
    renderRecurringTaskRules();
    render();
    setRecurringTaskStatus("Tâche récurrente ajoutée.");
  });

  updateRecurringTaskFrequencyVisibility();
  renderRecurringTaskRules();
  setRecurringTaskStatus("Configurez vos routines en quelques clics.");
}

function promptMoveTargetDay(fromDayKey) {
  const options = schedule
    .map((day, index) => `${index + 1}. ${day.dayName} ${day.dateLabel}`)
    .join("\n");
  const answer = window.prompt(
    `Déplacer cette tâche vers quel jour ?\n${options}`,
    "1",
  );

  if (!answer) {
    return null;
  }

  const index = Number.parseInt(answer.trim(), 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= schedule.length) {
    return null;
  }

  const target = schedule[index];
  if (target.key === fromDayKey) {
    return null;
  }

  return target.key;
}

function ruleAppliesToDay(rule, day) {
  const dayDate = dayKeyToDate(day.key);
  const startDate = dayKeyToDate(rule.startDate);
  const endDate = rule.endDate ? dayKeyToDate(rule.endDate) : null;
  if (!dayDate || !startDate) {
    return false;
  }
  if (dayDate < startDate) {
    return false;
  }
  if (endDate && dayDate > endDate) {
    return false;
  }

  if (rule.frequency === "daily") {
    return true;
  }

  return rule.weekdays.includes(day.weekdayIndex);
}

function getAppointmentsForDay(day) {
  const oneShots = (day.appointments || []).map((appointment) => ({
    ...appointment,
    isRecurring: false,
  }));

  const recurringForDay = recurringRules
    .filter((rule) => ruleAppliesToDay(rule, day))
    .map((rule) => ({
      id: `recurring-${rule.id}-${day.key}`,
      text: rule.text,
      time: rule.time,
      durationMinutes: rule.durationMinutes,
      isRecurring: true,
    }));

  const detachedForDay = detachedAppointments
    .filter((appointment) => appointment.date === day.key)
    .map((appointment) => ({
      id: appointment.id,
      time: appointment.time,
      text: appointment.text,
      durationMinutes: appointment.durationMinutes,
      isRecurring: false,
      isDetached: true,
    }));

  return oneShots.concat(detachedForDay, recurringForDay).sort((a, b) => {
    const aTime = parseTimeToMinutes(a.time || "");
    const bTime = parseTimeToMinutes(b.time || "");
    const aValue = aTime === null ? Number.POSITIVE_INFINITY : aTime;
    const bValue = bTime === null ? Number.POSITIVE_INFINITY : bTime;
    return aValue - bValue;
  });
}

function createTaskElement(dayKeyValue, task) {
  const isRecurringTask = !!task.isRecurringOccurrence;
  const li = document.createElement("li");
  li.className = `task-item${task.done ? " done" : ""}`;
  if (isRecurringTask) {
    li.classList.add("recurring-task");
  }
  li.draggable = !isRecurringTask;
  li.dataset.taskId = task.id;
  li.dataset.dayKey = dayKeyValue;

  li.addEventListener("dragstart", (event) => {
    if (isRecurringTask) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.setData(
      "application/json",
      JSON.stringify({ fromDayKey: dayKeyValue, taskId: task.id }),
    );
  });

  const main = document.createElement("div");
  main.className = "task-main";

  const check = document.createElement("input");
  const checkboxId = `task-${task.id}`;
  check.type = "checkbox";
  check.id = checkboxId;
  check.checked = !!task.done;
  check.addEventListener("change", () => {
    const day = schedule.find((d) => d.key === dayKeyValue);
    const target = day.tasks.find((t) => t.id === task.id);
    target.done = check.checked;
    saveSchedule();
    render();
    if (target.done) {
      launchConfetti();
    }
  });

  const text = document.createElement("label");
  text.className = "task-text";
  text.htmlFor = checkboxId;
  const textWrap = document.createElement("span");
  textWrap.className = "task-text-wrap";
  textWrap.append(task.text);
  if (isRecurringTask) {
    const badge = document.createElement("span");
    badge.className = "task-badge";
    badge.textContent = "⟳";
    badge.title = "Tâche récurrente";
    badge.setAttribute("aria-label", "Tâche récurrente");
    textWrap.append(badge);
  }
  text.append(textWrap);

  main.append(check, text);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const moveBtn = document.createElement("button");
  moveBtn.className = "task-move";
  moveBtn.type = "button";
  moveBtn.textContent = "Déplacer";
  if (isRecurringTask) {
    moveBtn.disabled = true;
    moveBtn.title = "Déplacez la règle récurrente, pas l'occurrence";
    moveBtn.setAttribute(
      "aria-label",
      "La tâche récurrente se déplace via sa règle",
    );
  } else {
    moveBtn.setAttribute("aria-label", "Déplacer la tâche vers un autre jour");
  }
  moveBtn.addEventListener("click", () => {
    if (isRecurringTask) {
      return;
    }

    const targetDayKey = promptMoveTargetDay(dayKeyValue);
    if (!targetDayKey) {
      return;
    }

    const fromDay = schedule.find((d) => d.key === dayKeyValue);
    const toDay = schedule.find((d) => d.key === targetDayKey);
    if (!fromDay || !toDay) {
      return;
    }

    const fromIndex = fromDay.tasks.findIndex((t) => t.id === task.id);
    if (fromIndex === -1) {
      return;
    }

    const [moved] = fromDay.tasks.splice(fromIndex, 1);
    toDay.tasks.push(moved);
    saveSchedule();
    render();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  if (isRecurringTask) {
    deleteBtn.textContent = "✏️";
    deleteBtn.classList.add("recurring-manage");
    deleteBtn.title = "Gérez la règle dans la page Ajouter";
    deleteBtn.setAttribute(
      "aria-label",
      "Gérer la règle depuis la page Ajouter",
    );
  } else {
    deleteBtn.textContent = "x";
    deleteBtn.disabled = !task.done;
    deleteBtn.setAttribute(
      "aria-label",
      task.done
        ? "Supprimer la tâche"
        : "Terminez la tâche pour activer la suppression",
    );
    deleteBtn.title = task.done
      ? "Supprimer la tâche"
      : "Terminez la tâche pour pouvoir la supprimer";
  }
  deleteBtn.addEventListener("click", () => {
    if (isRecurringTask) {
      window.location.href = "ajouter.html";
      return;
    }

    if (!task.done) {
      return;
    }
    const day = schedule.find((d) => d.key === dayKeyValue);
    day.tasks = day.tasks.filter((t) => t.id !== task.id);
    saveSchedule();
    render();
  });

  actions.append(moveBtn, deleteBtn);
  li.append(main, actions);
  return li;
}

function createAppointmentElement(dayKeyValue, appointment) {
  const li = document.createElement("li");
  li.className = "appointment-item";
  if (appointment.isRecurring) {
    li.classList.add("recurring");
  }

  const main = document.createElement("div");
  main.className = "appointment-main";

  const topLine = document.createElement("div");
  topLine.className = "appointment-topline";

  const time = document.createElement("span");
  time.className = "appointment-time";
  const startMinutes = parseTimeToMinutes(appointment.time || "");
  const durationMinutes = Number(appointment.durationMinutes || 0);
  const hasDuration = Number.isFinite(durationMinutes) && durationMinutes > 0;
  if (startMinutes !== null && hasDuration) {
    time.textContent = `${minutesToTimeLabel(startMinutes)}-${minutesToTimeLabel(startMinutes + durationMinutes)}`;
  } else {
    time.textContent = appointment.time || "--:--";
  }

  const text = document.createElement("span");
  text.className = "appointment-text";
  text.textContent = appointment.text;

  const duration = document.createElement("span");
  duration.className = "appointment-duration";
  duration.textContent = formatDuration(appointment.durationMinutes);

  topLine.append(time, duration);
  if (appointment.isRecurring) {
    const badge = document.createElement("span");
    badge.className = "appointment-badge";
    badge.textContent = "⟳";
    badge.title = "Récurrence";
    badge.setAttribute("aria-label", "Récurrence");
    topLine.append(badge);
  }
  main.append(topLine, text);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  if (appointment.isRecurring) {
    deleteBtn.textContent = "✏️";
    deleteBtn.title = "Gérez les récurrences dans la page Ajouter";
    deleteBtn.setAttribute(
      "aria-label",
      "Gérer les rendez-vous en récurrence depuis la page Ajouter",
    );
    deleteBtn.classList.add("recurring-manage");
  } else {
    deleteBtn.textContent = "x";
    deleteBtn.setAttribute("aria-label", "Supprimer le rendez-vous");
  }
  deleteBtn.addEventListener("click", () => {
    if (appointment.isRecurring) {
      window.location.href = "ajouter.html";
      return;
    }

    if (appointment.isDetached) {
      detachedAppointments = detachedAppointments.filter(
        (candidate) => candidate.id !== appointment.id,
      );
      saveDetachedAppointments();
      render();
      return;
    }

    const day = schedule.find((d) => d.key === dayKeyValue);
    day.appointments = day.appointments.filter((a) => a.id !== appointment.id);
    saveSchedule();
    render();
  });

  li.append(main, deleteBtn);
  return li;
}

function createDayCard(day) {
  const card = document.createElement("section");
  card.className = "day-card";
  card.dataset.dayKey = day.key;
  card.dataset.weekday = String(day.weekdayIndex);

  const title = document.createElement("h2");
  title.className = "day-title";
  title.textContent = `${day.dayName} ${day.dateLabel}`;

  const dayChip = document.createElement("p");
  dayChip.className = "day-chip";
  if (day.dayOffset === 0) {
    dayChip.textContent = "Aujourd'hui";
    dayChip.classList.add("today");
  } else if (day.dayOffset === 1) {
    dayChip.textContent = "Demain";
    dayChip.classList.add("tomorrow");
  } else {
    dayChip.textContent = `J+${day.dayOffset}`;
    dayChip.classList.add("later");
  }

  const tasksSection = document.createElement("div");
  tasksSection.className = "section";

  const taskList = document.createElement("ul");
  taskList.className = "task-list";
  taskList.dataset.dayKey = day.key;
  taskList.addEventListener("dragover", (event) => {
    event.preventDefault();
    taskList.classList.add("drag-target");
  });
  taskList.addEventListener("dragleave", () =>
    taskList.classList.remove("drag-target"),
  );
  taskList.addEventListener("drop", (event) => {
    event.preventDefault();
    taskList.classList.remove("drag-target");
    const payloadRaw = event.dataTransfer.getData("application/json");
    if (!payloadRaw) {
      return;
    }

    const payload = JSON.parse(payloadRaw);
    const fromDay = schedule.find((d) => d.key === payload.fromDayKey);
    const toDay = schedule.find((d) => d.key === day.key);
    if (!fromDay || !toDay) {
      return;
    }

    const fromIndex = fromDay.tasks.findIndex((t) => t.id === payload.taskId);
    if (fromIndex === -1) {
      return;
    }

    const [moved] = fromDay.tasks.splice(fromIndex, 1);
    toDay.tasks.push(moved);
    saveSchedule();
    render();
  });

  if (day.tasks.length > 0) {
    day.tasks.forEach((task) =>
      taskList.append(createTaskElement(day.key, task)),
    );
  } else {
    const empty = document.createElement("li");
    empty.className = "empty-marker";
    empty.innerHTML = '<span class="visually-hidden">Aucune tâche</span>';
    taskList.append(empty);
  }

  const taskForm = document.createElement("form");
  taskForm.className = "inline-form task-form";
  const taskInputId = `task-input-${day.key}`;
  taskForm.innerHTML = `
    <label class="visually-hidden" for="${taskInputId}">Nouvelle tâche pour ${day.dayName} ${day.dateLabel}</label>
    <input id="${taskInputId}" name="taskText" type="text" placeholder="Nouvelle tâche" required>
    <button type="submit">Ajouter</button>
  `;
  taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(taskForm);
    const text = String(formData.get("taskText") || "").trim();
    if (!text) {
      return;
    }
    day.tasks.push({ id: makeId(), text, done: false });
    saveSchedule();
    render();
  });

  tasksSection.append(taskList, taskForm);

  const appointmentsSection = document.createElement("div");
  appointmentsSection.className = "section";

  const appointmentList = document.createElement("ul");
  const dayAppointments = getAppointmentsForDay(day);
  if (dayAppointments.length > 0) {
    dayAppointments.forEach((appointment) => {
      appointmentList.append(createAppointmentElement(day.key, appointment));
    });
  } else {
    const empty = document.createElement("li");
    empty.className = "empty-marker";
    empty.innerHTML = '<span class="visually-hidden">Aucun rendez-vous</span>';
    appointmentList.append(empty);
  }

  const appointmentForm = document.createElement("form");
  appointmentForm.className = "inline-form appointment-form";
  const timeInputId = `appointment-time-${day.key}`;
  const durationInputId = `appointment-duration-${day.key}`;
  const textInputId = `appointment-text-${day.key}`;
  appointmentForm.innerHTML = `
    <div class="field-group appointment-description-group">
      <label class="field-label" for="${textInputId}">Description</label>
      <input id="${textInputId}" name="appointmentText" type="text" placeholder="Rendez-vous" required>
    </div>
    <div class="field-group appointment-time-group">
      <label class="field-label" for="${timeInputId}">Heure</label>
      <input id="${timeInputId}" name="appointmentTime" type="time" required>
    </div>
    <div class="field-group appointment-duration-group">
      <label class="field-label" for="${durationInputId}">Durée (min)</label>
      <input id="${durationInputId}" name="appointmentDuration" type="number" min="5" step="5" value="60" required>
    </div>
    <button type="submit">Fixer</button>
  `;
  appointmentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(appointmentForm);
    const time = String(formData.get("appointmentTime") || "").trim();
    const durationMinutes = Number(formData.get("appointmentDuration") || 0);
    const text = String(formData.get("appointmentText") || "").trim();
    if (
      !time ||
      !text ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0
    ) {
      return;
    }
    day.appointments.push({
      id: makeId(),
      time,
      text,
      durationMinutes: Math.round(durationMinutes),
    });
    saveSchedule();
    render();
  });

  appointmentsSection.append(appointmentList, appointmentForm);

  card.append(dayChip, title, tasksSection, appointmentsSection);
  return card;
}

function render() {
  const grid = document.getElementById("grid");
  if (!grid) {
    return;
  }

  grid.innerHTML = "";
  schedule.forEach((day) => {
    grid.append(createDayCard(day));
  });
}

function redirectToLogin() {
  window.location.href = "index.html";
}

function handleLogout() {
  if (pocketbase) {
    pocketbase.authStore.clear();
  }

  if (window.confirm("Effacer aussi les données locales de cet appareil ?")) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(RECURRING_STORAGE_KEY);
    localStorage.removeItem(DETACHED_APPOINTMENTS_STORAGE_KEY);
    localStorage.removeItem(RECURRING_TASK_STORAGE_KEY);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  }

  redirectToLogin();
}

function bindPlannerControls() {
  cloudStatusEl = document.getElementById("cloud-status");
  cloudPullBtnEl = document.getElementById("cloud-pull");
  cloudPushBtnEl = document.getElementById("cloud-push");
  plannerLogoutBtnEl = document.getElementById("planner-logout");

  if (cloudPullBtnEl) {
    cloudPullBtnEl.addEventListener("click", () => pullFromCloud(false));
  }
  if (cloudPushBtnEl) {
    cloudPushBtnEl.addEventListener("click", () => pushToCloud(false));
  }
  if (plannerLogoutBtnEl) {
    plannerLogoutBtnEl.addEventListener("click", handleLogout);
  }

  updateCloudButtons();
}

function ensureCloudSession() {
  const url = localStorage.getItem(PB_URL_KEY);
  if (!url) {
    redirectToLogin();
    return false;
  }

  try {
    initPocketBase(url);
  } catch (_error) {
    redirectToLogin();
    return false;
  }

  if (!pocketbase.authStore.isValid) {
    redirectToLogin();
    return false;
  }

  return true;
}

async function initApp() {
  bindPlannerControls();

  if (!ensureCloudSession()) {
    return;
  }

  schedule = loadSchedule();
  recurringRules = loadRecurringRules();
  recurringTaskRules = loadRecurringTaskRules();
  detachedAppointments = loadDetachedAppointments();
  syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
  localStorage.setItem(
    RECURRING_TASK_STORAGE_KEY,
    JSON.stringify(recurringTaskRules),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  history = mergeScheduleIntoHistory(loadHistory(), schedule);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  bindRecurringTaskControls();
  render();
  updateCloudButtons();
  setCloudStatus("Session cloud active. Synchronisation en cours...");

  await pullFromCloud(true);
  setCloudStatus("Session cloud active.");
}

initApp();
