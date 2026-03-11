const STORAGE_KEY = "quatorzaine_schedule_v1";
const RECURRING_STORAGE_KEY = "quatorzaine_recurring_v1";
const DETACHED_APPOINTMENTS_STORAGE_KEY = "quatorzaine_detached_appointments_v1";
const RECURRING_TASK_STORAGE_KEY = "quatorzaine_recurring_tasks_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
// ACTION_STATS_STORAGE_KEY is defined in shared.js
const HISTORY_MAX_DAYS = 3650;
const PB_URL_KEY = "quatorzaine_pb_url";
const PB_COLLECTION = "planner_snapshots";
const AUTO_PULL_INTERVAL_MS = 300000;
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
let detachedAppointments = [];
let recurringTaskRulesSnapshot = [];
let history = [];
let editingRecurringRuleId = null;
let pocketbase = null;
let cloudSaveTimer = null;
let autoPullTimer = null;
let cloudLastUpdatedAt = "";
let hasPendingLocalChanges = false;
let isPullInProgress = false;

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
      if (!parseDayKeyToDate(date)) {
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
        done: !!appointment.done,
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
      const keyDate = parseDayKeyToDate(key);
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
    const keyDate = parseDayKeyToDate(key);
    if (!keyDate) {
      return;
    }

    byKey.set(key, {
      key,
      weekdayIndex: keyDate.getDay(),
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

function loadRecurringTaskRulesSnapshot() {
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

function saveRecurringTaskRulesSnapshot() {
  localStorage.setItem(
    RECURRING_TASK_STORAGE_KEY,
    JSON.stringify(recurringTaskRulesSnapshot),
  );
}

function saveRecurringRules() {
  localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
  queueCloudSave();
}

function saveDetachedAppointments() {
  localStorage.setItem(
    DETACHED_APPOINTMENTS_STORAGE_KEY,
    JSON.stringify(detachedAppointments),
  );
  queueCloudSave();
}

// normalizeActionStats, loadActionStats, saveActionStats, mergeActionStats
// are defined in shared.js

function trackUserAction() {
  const now = new Date();
  const key = dayKey(now);
  const current = loadActionStats() || {
    total: 0,
    startedAt: now.toISOString(),
    byDay: {},
  };

  const next = {
    total: current.total + 1,
    startedAt: current.startedAt || now.toISOString(),
    byDay: {
      ...current.byDay,
      [key]: (current.byDay[key] || 0) + 1,
    },
  };

  saveActionStats(next);
}

function serializeSnapshot() {
  return JSON.stringify({
    schedule,
    recurringRules,
    detachedAppointments,
    recurringTaskRules: recurringTaskRulesSnapshot,
    history,
    actionStats: loadActionStats(),
  });
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function isReducedMotionPreferred() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById("appointment-status");
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? "error" : "info";
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
    let savedRecord = null;
    if (list.items.length > 0) {
      savedRecord = await pocketbase
        .collection(PB_COLLECTION)
        .update(list.items[0].id, payload);
    } else {
      savedRecord = await pocketbase.collection(PB_COLLECTION).create({
        owner: userId,
        ...payload,
      });
    }

    cloudLastUpdatedAt = String(savedRecord?.updated || cloudLastUpdatedAt || "");
    hasPendingLocalChanges = false;
  } catch (_error) {
    return;
  }
}

async function getSnapshotMeta() {
  if (!isCloudConnected()) {
    return null;
  }

  const userId = pocketbase.authStore.model.id;
  const list = await pocketbase.collection(PB_COLLECTION).getList(1, 1, {
    filter: `owner = "${userId}"`,
    sort: "-updated",
    fields: "id,updated",
  });

  return list.items.length > 0 ? list.items[0] : null;
}

function queueCloudSave() {
  if (!isCloudConnected()) {
    return;
  }

  hasPendingLocalChanges = true;

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
  }

  cloudSaveTimer = setTimeout(() => {
    pushSnapshotToCloud();
  }, 2000);
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
        actionStats: null,
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
            actionStats: null,
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
        actionStats: null,
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
      actionStats: null,
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
      actionStats: normalizeActionStats(rawValue.actionStats),
    };
  }

  return {
    schedule: [],
    recurringRules: [],
    detachedAppointments: [],
    recurringTaskRules: [],
    history: [],
    actionStats: null,
  };
}

async function pullSnapshotFromCloud(silent = false, prefetchedRecord = null) {
  if (!isCloudConnected() || isPullInProgress) {
    return;
  }

  isPullInProgress = true;

  try {
    let record = prefetchedRecord;

    if (!record) {
      const userId = pocketbase.authStore.model.id;
      const list = await pocketbase.collection(PB_COLLECTION).getList(1, 1, {
        filter: `owner = "${userId}"`,
        sort: "-updated",
      });
      record = list.items[0] || null;
    }

    if (!record) {
      return;
    }

    const snapshot = parseCloudSnapshot(record.schedule);
    schedule = normalizeSchedule(snapshot.schedule);
    recurringRules = normalizeRecurringRules(snapshot.recurringRules);
    detachedAppointments = normalizeDetachedAppointments(
      snapshot.detachedAppointments,
    );
    recurringTaskRulesSnapshot = normalizeRecurringTaskRules(
      snapshot.recurringTaskRules,
    );
    syncRecurringTasksIntoSchedule(schedule, recurringTaskRulesSnapshot);
    history = mergeScheduleIntoHistory(normalizeHistory(snapshot.history), schedule);
    const mergedActionStats = mergeActionStats(
      snapshot.actionStats,
      loadActionStats(),
    );

    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
    localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
    localStorage.setItem(
      DETACHED_APPOINTMENTS_STORAGE_KEY,
      JSON.stringify(detachedAppointments),
    );
    saveRecurringTaskRulesSnapshot();
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    if (mergedActionStats) {
      saveActionStats(mergedActionStats);
    }

    cloudLastUpdatedAt = String(record.updated || "");
    hasPendingLocalChanges = false;

    renderRulesList();
    renderRecurringTaskRules();
    renderUpcomingAppointments();

    if (!silent) {
      setStatus("Données cloud téléchargées.");
    }
  } catch (_error) {
    return;
  } finally {
    isPullInProgress = false;
  }
}

async function runAutoPullTick() {
  if (!isCloudConnected() || document.hidden) {
    return;
  }

  if (hasPendingLocalChanges || isPullInProgress) {
    return;
  }

  try {
    const record = await getSnapshotMeta();
    if (!record) {
      return;
    }

    const updatedAt = String(record.updated || "");
    if (!updatedAt) {
      return;
    }

    if (cloudLastUpdatedAt && updatedAt <= cloudLastUpdatedAt) {
      return;
    }

    const fullRecord = await pocketbase.collection(PB_COLLECTION).getOne(record.id);
    await pullSnapshotFromCloud(true, fullRecord);
  } catch (_error) {
    return;
  }
}

function startAutoPull() {
  if (autoPullTimer) {
    clearInterval(autoPullTimer);
  }

  autoPullTimer = setInterval(() => {
    runAutoPullTick();
  }, AUTO_PULL_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      runAutoPullTick();
    }
  });

  runAutoPullTick();
}

function getTodayDateValue() {
  return dayKey(new Date());
}

// parseDayKeyToDate is defined in shared.js

function recurringTaskId(ruleId, dayKeyValue) {
  return `rec-task-${ruleId}-${dayKeyValue}`;
}

function taskRuleAppliesToDay(rule, day) {
  const dayDate = parseDayKeyToDate(day.key);
  const startDate = parseDayKeyToDate(rule.startDate);
  const endDate = rule.endDate ? parseDayKeyToDate(rule.endDate) : null;
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

  return rule.weekdays.includes(dayDate.getDay());
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
        existing.id = recurringTaskId(rule.id, day.key);
        existing.text = rule.text;
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

function isDateInCurrentWindow(dateKey) {
  return schedule.some((day) => day.key === dateKey);
}

function formatUpcomingDate(dateKey) {
  const date = parseDayKeyToDate(dateKey);
  if (!date) {
    return dateKey;
  }

  return date.toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function renderUpcomingAppointments() {
  const listEl = document.getElementById("upcoming-list");
  const summaryEl = document.getElementById("upcoming-summary");
  listEl.innerHTML = "";

  const upcoming = detachedAppointments
    .filter((appointment) => !isDateInCurrentWindow(appointment.date))
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }
      return a.time.localeCompare(b.time);
    });

  summaryEl.textContent =
    upcoming.length === 0
      ? "Aucun rendez-vous ponctuel hors quatorzaine."
      : `${upcoming.length} rendez-vous ponctuel(s) à venir.`;

  if (upcoming.length === 0) {
    const empty = document.createElement("li");
    empty.className = "upcoming-item empty";
    empty.textContent =
      "Ajoutez un rendez-vous ponctuel hors quatorzaine pour l'afficher ici.";
    listEl.append(empty);
    return;
  }

  upcoming.forEach((appointment) => {
    const item = document.createElement("li");
    item.className = "upcoming-item";

    const text = document.createElement("div");
    text.className = "rule-text";

    const title = document.createElement("strong");
    title.textContent = appointment.text;

    const subtitle = document.createElement("span");
    subtitle.textContent = `${formatUpcomingDate(appointment.date)} à ${appointment.time} (${appointment.durationMinutes} min)`;

    text.append(title, subtitle);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "rule-delete";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      detachedAppointments = detachedAppointments.filter(
        (candidate) => candidate.id !== appointment.id,
      );
      trackUserAction();
      saveDetachedAppointments();
      renderUpcomingAppointments();
      setStatus("Rendez-vous à venir supprimé.");
    });

    item.append(text, deleteBtn);
    listEl.append(item);
  });
}

function renderRulesList() {
  const listEl = document.getElementById("rules-list");
  const summaryEl = document.getElementById("rules-summary");
  listEl.innerHTML = "";
  summaryEl.textContent =
    recurringRules.length === 0
      ? "Aucune récurrence active."
      : `${recurringRules.length} récurrence(s) active(s).`;

  if (recurringRules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-item empty";
    empty.textContent = "Aucun rendez-vous en récurrence.";
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
      if (editingRecurringRuleId === rule.id) {
        resetAppointmentFormToCreateMode();
      }
      recurringRules = recurringRules.filter((candidate) => candidate.id !== rule.id);
      trackUserAction();
      saveRecurringRules();
      renderRulesList();
      setStatus("Rendez-vous en récurrence supprimé.");
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "rule-edit";
    editBtn.textContent = "Modifier";
    editBtn.addEventListener("click", () => {
      beginRecurringEdit(rule.id);
    });

    const actions = document.createElement("div");
    actions.className = "rule-actions";
    actions.append(editBtn, deleteBtn);

    item.append(text, actions);
    listEl.append(item);
  });
}

function setRecurringTaskStatus(message, isError = false) {
  const statusEl = document.getElementById("recurring-task-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? "error" : "info";
}

function formatRecurringTaskRule(rule) {
  if (rule.frequency === "daily") {
    return `Tous les jours, depuis ${rule.startDate}${
      rule.endDate ? `, jusqu'au ${rule.endDate}` : ""
    }`;
  }

  const labels = rule.weekdays
    .slice()
    .sort((a, b) => a - b)
    .map((index) => DAY_NAMES[index].slice(0, 3));
  return `${labels.join(", ")}, depuis ${rule.startDate}${
    rule.endDate ? `, jusqu'au ${rule.endDate}` : ""
  }`;
}

function renderRecurringTaskRules() {
  const listEl = document.getElementById("recurring-task-list");
  if (!listEl) {
    return;
  }

  listEl.innerHTML = "";

  if (recurringTaskRulesSnapshot.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-item empty";
    empty.textContent = "Aucune tâche récurrente active.";
    listEl.append(empty);
    return;
  }

  recurringTaskRulesSnapshot.forEach((rule) => {
    const item = document.createElement("li");
    item.className = "rule-item";

    const text = document.createElement("div");
    text.className = "rule-text";

    const title = document.createElement("strong");
    title.textContent = rule.text;

    const subtitle = document.createElement("span");
    subtitle.textContent = formatRecurringTaskRule(rule);

    text.append(title, subtitle);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "rule-delete";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      recurringTaskRulesSnapshot = recurringTaskRulesSnapshot.filter(
        (candidate) => candidate.id !== rule.id,
      );
      trackUserAction();
      syncRecurringTasksIntoSchedule(schedule, recurringTaskRulesSnapshot);
      saveRecurringTaskRulesSnapshot();
      saveSchedule();
      renderRecurringTaskRules();
      setRecurringTaskStatus("Tâche récurrente supprimée.");
    });

    item.append(text, deleteBtn);
    listEl.append(item);
  });
}

function updateRecurringTaskFrequencyVisibility() {
  const frequencyEl = document.getElementById("task-recurring-frequency");
  const weekdayPickerEl = document.getElementById("task-recurring-weekdays");
  if (!frequencyEl || !weekdayPickerEl) {
    return;
  }

  const weekdayInputs = weekdayPickerEl.querySelectorAll('input[name="taskWeekday"]');

  if (frequencyEl.value === "weekly") {
    weekdayPickerEl.classList.remove("hidden");
    weekdayInputs.forEach((input) => {
      input.disabled = false;
    });
    return;
  }

  weekdayPickerEl.classList.add("hidden");
  weekdayInputs.forEach((input) => {
    input.checked = false;
    input.disabled = true;
  });
}

function bindRecurringTaskForm() {
  const formEl = document.getElementById("recurring-task-form");
  if (!formEl) {
    return;
  }

  const frequencyEl = document.getElementById("task-recurring-frequency");
  const startDateEl = document.getElementById("task-recurring-start");
  const endDateEl = document.getElementById("task-recurring-end");
  if (!frequencyEl || !startDateEl || !endDateEl) {
    return;
  }

  const today = getTodayDateValue();
  startDateEl.value = today;
  startDateEl.min = today;
  endDateEl.min = today;

  frequencyEl.addEventListener("change", updateRecurringTaskFrequencyVisibility);
  startDateEl.addEventListener("change", () => {
    const startDateValue = String(startDateEl.value || "").trim();
    endDateEl.min = startDateValue || today;

    if (endDateEl.value && endDateEl.value < endDateEl.min) {
      endDateEl.value = endDateEl.min;
    }
  });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(formEl);
    const text = String(formData.get("text") || "").trim();
    const frequency = String(formData.get("frequency") || "daily");
    const startDate = String(formData.get("startDate") || "").trim();
    const endDate = String(formData.get("endDate") || "").trim();
    const weekdays = formData
      .getAll("taskWeekday")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

    if (!text || !startDate) {
      setRecurringTaskStatus("Renseignez la tâche et la date de début.", true);
      return;
    }

    if (endDate && endDate < startDate) {
      setRecurringTaskStatus("La date de fin doit être après la date de début.", true);
      return;
    }

    if (frequency === "weekly" && weekdays.length === 0) {
      setRecurringTaskStatus(
        "Choisissez au moins un jour de la semaine pour cette tâche.",
        true,
      );
      return;
    }

    recurringTaskRulesSnapshot.push({
      id: makeId(),
      text,
      frequency: frequency === "weekly" ? "weekly" : "daily",
      startDate,
      endDate,
      weekdays,
    });

    trackUserAction();
    syncRecurringTasksIntoSchedule(schedule, recurringTaskRulesSnapshot);
    saveRecurringTaskRulesSnapshot();
    saveSchedule();
    renderRecurringTaskRules();
    setRecurringTaskStatus("Tâche récurrente enregistrée.");

    formEl.reset();
    startDateEl.value = today;
    endDateEl.value = "";
    endDateEl.min = today;
    updateRecurringTaskFrequencyVisibility();
  });

  updateRecurringTaskFrequencyVisibility();
}

function resetAppointmentFormToCreateMode() {
  const formEl = document.getElementById("appointment-form");
  const modeEl = document.getElementById("appointment-mode");
  const startDateEl = document.getElementById("appointment-start-date");
  const endDateEl = document.getElementById("appointment-end-date");
  const dateEl = document.getElementById("appointment-date");
  const submitBtnEl = document.getElementById("appointment-submit");
  const cancelBtnEl = document.getElementById("appointment-cancel");

  const today = getTodayDateValue();
  editingRecurringRuleId = null;
  formEl.reset();
  modeEl.value = "one-shot";
  startDateEl.value = today;
  endDateEl.value = "";
  dateEl.value = today;
  submitBtnEl.textContent = "Enregistrer";
  cancelBtnEl.classList.add("hidden");
  updateModeVisibility();
}

function beginRecurringEdit(ruleId) {
  const rule = recurringRules.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    return;
  }

  const modeEl = document.getElementById("appointment-mode");
  const textEl = document.getElementById("appointment-text");
  const timeEl = document.getElementById("appointment-time");
  const durationEl = document.getElementById("appointment-duration");
  const startDateEl = document.getElementById("appointment-start-date");
  const endDateEl = document.getElementById("appointment-end-date");
  const frequencyEl = document.getElementById("recurrence-frequency");
  const submitBtnEl = document.getElementById("appointment-submit");
  const cancelBtnEl = document.getElementById("appointment-cancel");
  const weekdayInputs = document.querySelectorAll('input[name="weekday"]');

  editingRecurringRuleId = rule.id;
  modeEl.value = "recurring";
  textEl.value = rule.text;
  timeEl.value = rule.time;
  durationEl.value = String(rule.durationMinutes);
  startDateEl.value = rule.startDate;
  endDateEl.value = rule.endDate || "";
  frequencyEl.value = rule.frequency;

  weekdayInputs.forEach((input) => {
    const day = Number(input.value);
    input.checked = rule.weekdays.includes(day);
  });

  submitBtnEl.textContent = "Mettre à jour";
  cancelBtnEl.classList.remove("hidden");
  updateModeVisibility();

  textEl.focus();
  textEl.scrollIntoView({
    behavior: isReducedMotionPreferred() ? "auto" : "smooth",
    block: "center",
  });
  setStatus("Modification d'une récurrence en cours.");
}

function updateModeVisibility() {
  const mode = document.getElementById("appointment-mode").value;
  const frequency = document.getElementById("recurrence-frequency").value;

  const oneShotOnlyEls = document.querySelectorAll(".one-shot-only");
  const recurringOnlyEls = document.querySelectorAll(".recurring-only");
  const weekdayPickerEl = document.querySelector(".weekday-picker");
  const dateEl = document.getElementById("appointment-date");
  const startDateEl = document.getElementById("appointment-start-date");
  const modeHelpEl = document.getElementById("mode-help");
  const weekdayInputs = document.querySelectorAll('input[name="weekday"]');

  if (mode === "one-shot") {
    oneShotOnlyEls.forEach((el) => el.classList.remove("hidden"));
    recurringOnlyEls.forEach((el) => el.classList.add("hidden"));
    dateEl.required = true;
    startDateEl.required = false;
    modeHelpEl.textContent =
      "Ponctuel : ajoute ce rendez-vous une seule fois, même hors quatorzaine.";
    return;
  }

  oneShotOnlyEls.forEach((el) => el.classList.add("hidden"));
  recurringOnlyEls.forEach((el) => el.classList.remove("hidden"));
  dateEl.required = false;
  startDateEl.required = true;
  modeHelpEl.textContent =
    "Récurrence : ce rendez-vous apparaît automatiquement sur les jours choisis.";

  if (frequency === "weekly") {
    weekdayPickerEl.classList.remove("hidden");
    weekdayInputs.forEach((input) => {
      input.disabled = false;
    });
  } else {
    weekdayPickerEl.classList.add("hidden");
    weekdayInputs.forEach((input) => {
      input.checked = false;
      input.disabled = true;
    });
  }
}

function bindForm() {
  const formEl = document.getElementById("appointment-form");
  const modeEl = document.getElementById("appointment-mode");
  const frequencyEl = document.getElementById("recurrence-frequency");
  const startDateEl = document.getElementById("appointment-start-date");
  const endDateEl = document.getElementById("appointment-end-date");
  const dateEl = document.getElementById("appointment-date");
  const cancelBtnEl = document.getElementById("appointment-cancel");

  const today = getTodayDateValue();
  startDateEl.value = today;
  dateEl.value = today;
  startDateEl.min = today;
  endDateEl.min = today;
  dateEl.min = today;

  startDateEl.addEventListener("change", () => {
    const startDateValue = String(startDateEl.value || "").trim();
    endDateEl.min = startDateValue || today;

    if (endDateEl.value && endDateEl.value < endDateEl.min) {
      endDateEl.value = endDateEl.min;
    }
  });

  modeEl.addEventListener("change", updateModeVisibility);
  frequencyEl.addEventListener("change", updateModeVisibility);
  cancelBtnEl.addEventListener("click", () => {
    resetAppointmentFormToCreateMode();
    setStatus("Modification annulée.");
  });
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
      editingRecurringRuleId = null;
      const date = String(formData.get("date") || "").trim();
      const day = schedule.find((candidate) => candidate.key === date);

      if (day) {
        day.appointments.push({
          id: makeId(),
          time,
          text,
          durationMinutes: Math.round(durationMinutes),
          done: false,
        });
        trackUserAction();
        saveSchedule();
        setStatus("Rendez-vous ponctuel enregistré dans la quatorzaine.");
      } else {
        detachedAppointments.push({
          id: makeId(),
          date,
          time,
          text,
          durationMinutes: Math.round(durationMinutes),
          done: false,
        });
        trackUserAction();
        saveDetachedAppointments();
        setStatus(
          "Rendez-vous ponctuel enregistré hors quatorzaine. Il apparaîtra au bon moment.",
        );
        renderUpcomingAppointments();
      }
      resetAppointmentFormToCreateMode();
      return;
    }

    const frequency = String(formData.get("frequency") || "daily");
    const endDate = String(formData.get("endDate") || "").trim();
    const weekdays = formData
      .getAll("weekday")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

    if (!startDate) {
      setStatus("Choisissez une date de début.", true);
      return;
    }
    if (endDate && endDate < startDate) {
      setStatus("La date de fin doit être après la date de début.", true);
      return;
    }
    if (frequency === "weekly" && weekdays.length === 0) {
      const startDateObj = parseDayKeyToDate(startDate);
      if (startDateObj) {
        weekdays.push(startDateObj.getDay());
      }
    }
    if (frequency === "weekly" && weekdays.length === 0) {
      setStatus("Choisissez au moins un jour pour la récurrence hebdomadaire.", true);
      return;
    }

    const nextRule = {
      id: editingRecurringRuleId || makeId(),
      text,
      time,
      durationMinutes: Math.round(durationMinutes),
      frequency: frequency === "weekly" ? "weekly" : "daily",
      startDate,
      endDate,
      weekdays,
    };

    if (editingRecurringRuleId) {
      recurringRules = recurringRules.map((rule) =>
        rule.id === editingRecurringRuleId ? nextRule : rule,
      );
    } else {
      recurringRules.push(nextRule);
    }

    trackUserAction();
    saveRecurringRules();
    renderRulesList();
    const wasEditing = !!editingRecurringRuleId;
    resetAppointmentFormToCreateMode();
    setStatus(
      wasEditing
        ? "Récurrence modifiée avec succès."
        : "Rendez-vous en récurrence enregistré.",
    );
  });
}

async function initApp() {
  schedule = loadSchedule();
  recurringRules = loadRecurringRules();
  detachedAppointments = loadDetachedAppointments();
  recurringTaskRulesSnapshot = loadRecurringTaskRulesSnapshot();
  syncRecurringTasksIntoSchedule(schedule, recurringTaskRulesSnapshot);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  saveRecurringTaskRulesSnapshot();
  history = mergeScheduleIntoHistory(loadHistory(), schedule);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  const existingActionStats = loadActionStats();
  if (!existingActionStats) {
    saveActionStats({ total: 0, startedAt: new Date().toISOString(), byDay: {} });
  }
  initPocketBase(localStorage.getItem(PB_URL_KEY));
  bindForm();
  bindRecurringTaskForm();
  renderRulesList();
  renderRecurringTaskRules();
  renderUpcomingAppointments();
  setStatus("Prêt : ajoutez votre prochain rendez-vous.");
  setRecurringTaskStatus("Configurez vos tâches récurrentes.");

  await pullSnapshotFromCloud(true);
  startAutoPull();
}

initApp();
