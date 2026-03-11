const STORAGE_KEY = "quatorzaine_schedule_v1";
const RECURRING_STORAGE_KEY = "quatorzaine_recurring_v1";
const DETACHED_APPOINTMENTS_STORAGE_KEY = "quatorzaine_detached_appointments_v1";
const RECURRING_TASK_STORAGE_KEY = "quatorzaine_recurring_tasks_v1";
const RECURRING_APPOINTMENT_DONE_STORAGE_KEY = "quatorzaine_recurring_appointment_done_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
// ACTION_STATS_STORAGE_KEY is defined in shared.js
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
const PB_EXTERNAL_EVENTS_COLLECTION = "external_events";
const AUTO_PULL_INTERVAL_MS = 300000;
const LAYOUT_MODE_KEY = "quatorzaine_layout_mode_v1";
const LAYOUT_MODE_COMPACT = "compact";
const LAYOUT_MODE_COMFORT = "comfort";
const CALENDAR_WORKER_URL_KEY_PREFIX = "quatorzaine_calendar_worker_url_v2";

let schedule = [];
let recurringRules = [];
let detachedAppointments = [];
let recurringTaskRules = [];
let recurringAppointmentDone = {};
let history = [];
let externalEvents = [];
let pocketbase = null;
let cloudSaveTimer = null;
let autoPullTimer = null;
let cloudLastUpdatedAt = "";
let hasPendingLocalChanges = false;
let isPullInProgress = false;

let cloudStatusEl;
let cloudPullBtnEl;
let cloudPushBtnEl;
let connectGoogleBtnEl;
let connectOutlookBtnEl;
let syncCalendarsBtnEl;
let layoutToggleBtnEl;
let plannerLogoutBtnEl;
let calendarStatusEl;
let recurringTaskFormEl;
let recurringTaskStatusEl;
let recurringTaskListEl;

function initLucideIcons() {
  if (!window.lucide || typeof window.lucide.createIcons !== "function") {
    return;
  }

  window.lucide.createIcons();
}

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
      tasks: Array.isArray(previous.tasks)
        ? previous.tasks
            .map((task) => normalizeTask(task, day.key))
            .filter(Boolean)
        : [],
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
        const normalizedTask = normalizeTask(task, savedDay.key);
        if (!normalizedTask) {
          return;
        }

        targetDay.tasks.unshift({
          ...normalizedTask,
          done: false,
        });
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

    const currentTasks = Array.isArray(day.tasks)
      ? day.tasks.map((task) => ({
          id: typeof task?.id === "string" && task.id ? task.id : makeId(),
          text: String(task?.text || ""),
          done: !!task?.done,
        }))
      : [];

    const previousDay = byKey.get(key);
    const previousDoneTasks = Array.isArray(previousDay?.tasks)
      ? previousDay.tasks.filter((task) => {
          if (!task?.done || !task?.id) {
            return false;
          }

          return !currentTasks.some((currentTask) => currentTask.id === task.id);
        })
      : [];

    byKey.set(key, {
      key,
      weekdayIndex:
        Number.isInteger(day.weekdayIndex) && day.weekdayIndex >= 0 && day.weekdayIndex <= 6
          ? day.weekdayIndex
          : keyDate.getDay(),
      tasks: currentTasks.concat(previousDoneTasks),
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
            recurringAppointmentDone: {},
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
      recurringAppointmentDone: {},
      history: [],
      actionStats: null,
    };
  }

  if (rawValue && typeof rawValue === "object") {
    const recurringAppointmentDone = rawValue.recurringAppointmentDone && typeof rawValue.recurringAppointmentDone === "object"
      ? rawValue.recurringAppointmentDone
      : {};
    
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
      recurringAppointmentDone,
      history: Array.isArray(rawValue.history) ? rawValue.history : [],
      actionStats: normalizeActionStats(rawValue.actionStats),
    };
  }

  return {
    schedule: [],
    recurringRules: [],
    detachedAppointments: [],
    recurringTaskRules: [],
    recurringAppointmentDone: {},
    history: [],
    actionStats: null,
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

function loadRecurringAppointmentDone() {
  const savedRaw = localStorage.getItem(RECURRING_APPOINTMENT_DONE_STORAGE_KEY);
  if (!savedRaw) {
    return {};
  }

  try {
    const parsed = JSON.parse(savedRaw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveRecurringAppointmentDone() {
  localStorage.setItem(
    RECURRING_APPOINTMENT_DONE_STORAGE_KEY,
    JSON.stringify(recurringAppointmentDone),
  );
  queueCloudSave();
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
    recurringAppointmentDone,
    history,
    actionStats: loadActionStats(),
  });
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function createdAtFromTaskId(taskId) {
  if (typeof taskId !== "string") {
    return "";
  }

  const [timestampRaw] = taskId.split("-");
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function normalizeTask(task, fallbackDayKey = "") {
  if (!task || typeof task !== "object") {
    return null;
  }

  const id = typeof task.id === "string" && task.id ? task.id : makeId();
  const text = String(task.text || "").trim();
  if (!text) {
    return null;
  }

  const rawCreatedAt = String(task.createdAt || "").trim();
  const parsedCreatedAt = rawCreatedAt ? new Date(rawCreatedAt) : null;
  let createdAt =
    parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime())
      ? parsedCreatedAt.toISOString()
      : "";

  if (!createdAt && fallbackDayKey) {
    const fallbackDate = dayKeyToDate(fallbackDayKey);
    if (fallbackDate) {
      createdAt = fallbackDate.toISOString();
    }
  }

  if (!createdAt) {
    createdAt = createdAtFromTaskId(id);
  }

  if (!createdAt) {
    createdAt = new Date().toISOString();
  }

  return {
    ...task,
    id,
    text,
    done: !!task.done,
    createdAt,
  };
}

function getTaskAgeInfo(task, dayKeyValue) {
  const fallbackDate = dayKeyToDate(dayKeyValue);
  const createdAtRaw = String(task?.createdAt || "").trim();
  const createdDate = createdAtRaw ? new Date(createdAtRaw) : null;
  const createdMs =
    createdDate && !Number.isNaN(createdDate.getTime())
      ? createdDate.getTime()
      : fallbackDate
        ? fallbackDate.getTime()
        : Date.now();

  const elapsedMs = Math.max(0, Date.now() - createdMs);
  const elapsedDays = Math.floor(elapsedMs / 86400000);

  if (elapsedDays <= 2) {
    return {
      stage: 0,
      symbol: "~---",
      label: "tout frais",
    };
  }

  if (elapsedDays <= 6) {
    return {
      stage: 1,
      symbol: "~~--",
      label: "en rythme",
    };
  }

  if (elapsedDays <= 13) {
    return {
      stage: 2,
      symbol: "~~~-",
      label: "bien installee",
    };
  }

  return {
    stage: 3,
    symbol: "~~~~",
    label: "longue trame",
  };
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
  cloudStatusEl.dataset.state = isError ? "error" : "info";
}

function setCalendarStatus(message, isError = false) {
  if (!calendarStatusEl) {
    return;
  }
  calendarStatusEl.textContent = message;
  calendarStatusEl.dataset.state = isError ? "error" : "info";
}

function getCalendarWorkerUrlStorageKey() {
  const pbUrl = String(localStorage.getItem(PB_URL_KEY) || "").trim().toLowerCase();
  if (!pbUrl) {
    return `${CALENDAR_WORKER_URL_KEY_PREFIX}::default`;
  }
  return `${CALENDAR_WORKER_URL_KEY_PREFIX}::${pbUrl}`;
}

function resolveCalendarWorkerUrl() {
  const saved = String(localStorage.getItem(getCalendarWorkerUrlStorageKey()) || "").trim();
  if (saved) {
    return saved.replace(/\/$/, "");
  }

  return "";
}

function ensureCalendarWorkerUrl() {
  const existing = resolveCalendarWorkerUrl();
  if (existing) {
    return existing;
  }

  const answer = window.prompt(
    "URL du service OAuth/sync (Cloudflare Worker)",
    "https://quatorzaine-calendar-worker-production.bvh8199.workers.dev",
  );
  const next = String(answer || "").trim().replace(/\/$/, "");
  if (!next) {
    setCalendarStatus("Aucune URL Worker fournie.", true);
    return "";
  }

  localStorage.setItem(getCalendarWorkerUrlStorageKey(), next);
  setCalendarStatus("Service calendrier configuré pour cet appareil.");
  return next;
}

async function requestOAuthStartRedirect(workerUrl, provider, returnTo) {
  const response = await fetch(`${workerUrl}/oauth/${provider}/start`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${pocketbase.authStore.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ returnTo }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json().catch(() => ({}));
  const redirectUrl = String(payload?.redirectUrl || "").trim();
  if (!redirectUrl) {
    throw new Error("URL OAuth manquante");
  }

  return redirectUrl;
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
  if (connectGoogleBtnEl) {
    connectGoogleBtnEl.disabled = !connected;
  }
  if (connectOutlookBtnEl) {
    connectOutlookBtnEl.disabled = !connected;
  }
  if (syncCalendarsBtnEl) {
    syncCalendarsBtnEl.disabled = !connected;
  }
}

function normalizeLayoutMode(mode) {
  if (mode === LAYOUT_MODE_COMPACT || mode === LAYOUT_MODE_COMFORT) {
    return mode;
  }
  return LAYOUT_MODE_COMFORT;
}

function getDefaultLayoutMode() {
  const isLargeDesktop = window.innerWidth >= 1600 && window.innerHeight >= 900;
  return isLargeDesktop ? LAYOUT_MODE_COMPACT : LAYOUT_MODE_COMFORT;
}

function getSavedLayoutMode() {
  return normalizeLayoutMode(localStorage.getItem(LAYOUT_MODE_KEY));
}

function applyLayoutMode(mode) {
  const resolvedMode = normalizeLayoutMode(mode);
  const isCompact = resolvedMode === LAYOUT_MODE_COMPACT;
  document.body.classList.toggle("layout-compact", isCompact);

  if (layoutToggleBtnEl) {
    layoutToggleBtnEl.setAttribute("aria-pressed", String(isCompact));
    layoutToggleBtnEl.innerHTML = isCompact
      ? '<i class="toolbar-icon" data-lucide="rows-3" aria-hidden="true"></i> Vue compacte 14/écran'
      : '<i class="toolbar-icon" data-lucide="rows-4" aria-hidden="true"></i> Vue confort';
    initLucideIcons();
  }
}

function setLayoutMode(mode) {
  const resolvedMode = normalizeLayoutMode(mode);
  localStorage.setItem(LAYOUT_MODE_KEY, resolvedMode);
  applyLayoutMode(resolvedMode);
}

function toggleLayoutMode() {
  const isCurrentlyCompact = document.body.classList.contains("layout-compact");
  setLayoutMode(isCurrentlyCompact ? LAYOUT_MODE_COMFORT : LAYOUT_MODE_COMPACT);
}

function normalizeExternalEvent(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const startsAt = String(record.starts_at || "").trim();
  const endsAt = String(record.ends_at || "").trim();
  const startsDate = startsAt ? new Date(startsAt) : null;
  const endsDate = endsAt ? new Date(endsAt) : null;
  if (!startsDate || Number.isNaN(startsDate.getTime())) {
    return null;
  }

  const startLabel = `${String(startsDate.getHours()).padStart(2, "0")}:${String(startsDate.getMinutes()).padStart(2, "0")}`;
  const durationMinutes = endsDate && !Number.isNaN(endsDate.getTime())
    ? Math.max(1, Math.round((endsDate.getTime() - startsDate.getTime()) / 60000))
    : 60;

  return {
    id: String(record.external_event_id || record.id || makeId()),
    provider: String(record.provider || "").trim().toLowerCase(),
    date: dayKey(startsDate),
    time: startLabel,
    text: String(record.title || "Événement").trim() || "Événement",
    durationMinutes,
    isExternal: true,
  };
}

async function loadExternalEvents() {
  if (!isCloudConnected()) {
    externalEvents = [];
    return;
  }

  try {
    const userId = pocketbase.authStore.model.id;
    const records = await pocketbase.collection(PB_EXTERNAL_EVENTS_COLLECTION).getFullList({
      filter: `owner = "${userId}"`,
      sort: "starts_at",
      fields: "id,provider,external_event_id,title,starts_at,ends_at",
    });
    externalEvents = records.map((record) => normalizeExternalEvent(record)).filter(Boolean);
  } catch (_error) {
    externalEvents = [];
  }
}

function providerLabel(provider) {
  return provider === "microsoft" ? "Outlook" : "Google";
}

async function beginCalendarConnect(provider) {
  if (!isCloudConnected()) {
    setCalendarStatus("Connectez-vous d'abord à PocketBase.", true);
    return;
  }

  try {
    await pocketbase.collection("users").authRefresh();
  } catch (_error) {
    setCalendarStatus(
      "Session PocketBase expirée. Reconnectez-vous puis réessayez.",
      true,
    );
    return;
  }

  const workerUrl = ensureCalendarWorkerUrl();
  if (!workerUrl) {
    return;
  }

  const providerKey = provider === "microsoft" ? "microsoft" : "google";
  const returnTo = window.location.href;

  setCalendarStatus(`Ouverture de la connexion ${providerLabel(providerKey)}...`);
  try {
    const redirectUrl = await requestOAuthStartRedirect(
      workerUrl,
      providerKey,
      returnTo,
    );
    window.location.href = redirectUrl;
  } catch (error) {
    setCalendarStatus(
      `Échec de préparation OAuth ${providerLabel(providerKey)}: ${error.message}`,
      true,
    );
  }
}

async function syncExternalCalendars() {
  if (!isCloudConnected()) {
    setCalendarStatus("Connectez-vous d'abord à PocketBase.", true);
    return;
  }

  const workerUrl = ensureCalendarWorkerUrl();
  if (!workerUrl) {
    return;
  }

  setCalendarStatus("Synchronisation des agendas externes en cours...");

  try {
    const response = await fetch(`${workerUrl}/sync/self`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${pocketbase.authStore.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ daysAhead: 30 }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await loadExternalEvents();
    render();
    setCalendarStatus("Agendas Google/Outlook synchronisés.");
  } catch (error) {
    setCalendarStatus(
      `Échec de synchronisation des agendas: ${error.message}`,
      true,
    );
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

async function pullFromCloud(silent = false, prefetchedRecord = null) {
  if (!isCloudConnected()) {
    setCloudStatus("Connectez-vous d'abord à PocketBase.", true);
    return;
  }

  if (isPullInProgress) {
    return;
  }

  isPullInProgress = true;

  try {
    const record = prefetchedRecord || (await getSnapshotRecord(false));
    if (!record) {
      if (!silent) {
        setCloudStatus("Aucune donnée cloud trouvée. Rien à télécharger.");
      }
      isPullInProgress = false;
      return;
    }

    const snapshot = parseCloudSnapshot(record.schedule);
    schedule = normalizeSchedule(snapshot.schedule);
    recurringRules = normalizeRecurringRules(snapshot.recurringRules);
    detachedAppointments = normalizeDetachedAppointments(
      snapshot.detachedAppointments,
    );
    recurringTaskRules = normalizeRecurringTaskRules(snapshot.recurringTaskRules);
    recurringAppointmentDone = snapshot.recurringAppointmentDone || {};
    syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
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
    localStorage.setItem(
      RECURRING_TASK_STORAGE_KEY,
      JSON.stringify(recurringTaskRules),
    );
    localStorage.setItem(
      RECURRING_APPOINTMENT_DONE_STORAGE_KEY,
      JSON.stringify(recurringAppointmentDone),
    );
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    if (mergedActionStats) {
      saveActionStats(mergedActionStats);
    }
    cloudLastUpdatedAt = String(record.updated || "");
    hasPendingLocalChanges = false;
    renderRecurringTaskRules();
    render();

    if (!silent) {
      setCloudStatus("Données cloud téléchargées sur cet appareil.");
    }
  } catch (error) {
    setCloudStatus(`Échec du téléchargement cloud: ${error.message}`, true);
  } finally {
    isPullInProgress = false;
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
    let savedRecord = null;

    if (record) {
      savedRecord = await pocketbase
        .collection(PB_COLLECTION)
        .update(record.id, payload);
    } else {
      savedRecord = await pocketbase.collection(PB_COLLECTION).create({
        owner: pocketbase.authStore.model.id,
        ...payload,
      });
    }

    cloudLastUpdatedAt = String(savedRecord?.updated || cloudLastUpdatedAt || "");
    hasPendingLocalChanges = false;

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

  hasPendingLocalChanges = true;

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
  }

  cloudSaveTimer = setTimeout(() => {
    pushToCloud(true);
  }, 2000);
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
    await pullFromCloud(true, fullRecord);
    setCloudStatus("Mise à jour cloud détectée et téléchargée.");
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
  recurringTaskStatusEl.dataset.state = isError ? "error" : "info";
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
      trackUserAction();
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

    trackUserAction();
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
    done: !!appointment.done,
  }));

  const recurringForDay = recurringRules
    .filter((rule) => ruleAppliesToDay(rule, day))
    .map((rule) => {
      const appointmentId = `recurring-${rule.id}-${day.key}`;
      return {
        id: appointmentId,
        text: rule.text,
        time: rule.time,
        durationMinutes: rule.durationMinutes,
        isRecurring: true,
        recurringRuleId: rule.id,
        done: !!recurringAppointmentDone[appointmentId],
      };
    });

  const detachedForDay = detachedAppointments
    .filter((appointment) => appointment.date === day.key)
    .map((appointment) => ({
      id: appointment.id,
      time: appointment.time,
      text: appointment.text,
      durationMinutes: appointment.durationMinutes,
      isRecurring: false,
      isDetached: true,
      done: !!appointment.done,
    }));

  const externalForDay = externalEvents
    .filter((event) => event.date === day.key)
    .map((event) => ({
      id: event.id,
      time: event.time,
      text: event.text,
      durationMinutes: event.durationMinutes,
      isRecurring: false,
      isExternal: true,
      provider: event.provider,
      done: false,
    }));

  return oneShots.concat(detachedForDay, externalForDay, recurringForDay).sort((a, b) => {
    const aTime = parseTimeToMinutes(a.time || "");
    const bTime = parseTimeToMinutes(b.time || "");
    const aValue = aTime === null ? Number.POSITIVE_INFINITY : aTime;
    const bValue = bTime === null ? Number.POSITIVE_INFINITY : bTime;
    return aValue - bValue;
  });
}

function createTaskElement(dayKeyValue, task) {
  const isRecurringTask = !!task.isRecurringOccurrence;
  const isDoneTask = !!task.done;
  const taskAge = getTaskAgeInfo(task, dayKeyValue);
  const li = document.createElement("li");
  li.className = `task-item${task.done ? " done" : ""}`;
  if (isDoneTask) {
    li.classList.add("done-compact");
  }
  if (isRecurringTask) {
    li.classList.add("recurring-task");
  } else {
    li.classList.add(`task-age-stage-${taskAge.stage}`);
  }
  li.draggable = !isRecurringTask && !isDoneTask;
  li.dataset.taskId = task.id;
  li.dataset.dayKey = dayKeyValue;

  li.addEventListener("dragstart", (event) => {
    if (isRecurringTask || isDoneTask) {
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
    trackUserAction();
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

  if (isDoneTask) {
    main.classList.add("task-main-done");
    main.append(text);
    li.append(main);
    li.title = "Tache terminee";
    return li;
  }

  main.append(check, text);
  li.title = isRecurringTask ? "Tache recurrente" : `Tache ${taskAge.label}`;

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
    trackUserAction();
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
    trackUserAction();
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
  if (appointment.isExternal) {
    li.classList.add("external");
  }
  if (appointment.isRecurring) {
    li.classList.add("recurring");
  }
  if (appointment.done) {
    li.classList.add("done");
  }

  const main = document.createElement("div");
  main.className = "appointment-main";

  const topLine = document.createElement("div");
  topLine.className = "appointment-topline";

  if (!appointment.isExternal) {
    const check = document.createElement("input");
    const checkboxId = `appointment-${appointment.id}`;
    check.type = "checkbox";
    check.id = checkboxId;
    check.checked = !!appointment.done;
    check.className = "appointment-checkbox";
    check.addEventListener("change", () => {
      if (appointment.isRecurring) {
        recurringAppointmentDone[appointment.id] = check.checked;
        trackUserAction();
        saveRecurringAppointmentDone();
        render();
        if (check.checked) {
          launchConfetti();
        }
        return;
      }

      if (appointment.isDetached) {
        const target = detachedAppointments.find((a) => a.id === appointment.id);
        if (target) {
          target.done = check.checked;
          trackUserAction();
          saveDetachedAppointments();
          render();
        }
        return;
      }

      const day = schedule.find((d) => d.key === dayKeyValue);
      const target = day.appointments.find((a) => a.id === appointment.id);
      if (target) {
        target.done = check.checked;
        trackUserAction();
        saveSchedule();
        render();
        if (target.done) {
          launchConfetti();
        }
      }
    });
    topLine.append(check);
  }

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
  if (appointment.isExternal) {
    const source = document.createElement("span");
    source.className = `appointment-source ${appointment.provider || "google"}`;
    source.textContent = providerLabel(appointment.provider || "google");
    source.title = "Événement importé en lecture seule";
    topLine.append(source);
  }
  if (appointment.isRecurring) {
    const badge = document.createElement("span");
    badge.className = "appointment-badge";
    badge.textContent = "⟳";
    badge.title = "Récurrence";
    badge.setAttribute("aria-label", "Récurrence");
    topLine.append(badge);
  }
  main.append(topLine, text);

  if (appointment.isExternal) {
    li.append(main);
    return li;
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  
  if (appointment.isRecurring) {
    if (appointment.done) {
      deleteBtn.textContent = "x";
      deleteBtn.setAttribute("aria-label", "Retirer le statut effectué");
      deleteBtn.title = "Retirer le statut effectué (le rendez-vous récurrent réapparaîtra)";
    } else {
      deleteBtn.textContent = "✏️";
      deleteBtn.title = "Gérez les récurrences dans la page Ajouter";
      deleteBtn.setAttribute(
        "aria-label",
        "Gérer les rendez-vous en récurrence depuis la page Ajouter",
      );
      deleteBtn.classList.add("recurring-manage");
    }
  } else {
    deleteBtn.textContent = "x";
    deleteBtn.disabled = !appointment.done;
    deleteBtn.setAttribute(
      "aria-label",
      appointment.done
        ? "Supprimer le rendez-vous"
        : "Terminez le rendez-vous pour activer la suppression",
    );
    deleteBtn.title = appointment.done
      ? "Supprimer le rendez-vous"
      : "Terminez le rendez-vous pour pouvoir le supprimer";
  }
  
  deleteBtn.addEventListener("click", () => {
    if (appointment.isRecurring) {
      if (appointment.done) {
        delete recurringAppointmentDone[appointment.id];
        trackUserAction();
        saveRecurringAppointmentDone();
        render();
      } else {
        window.location.href = "ajouter.html";
      }
      return;
    }

    if (!appointment.done) {
      return;
    }

    if (appointment.isDetached) {
      detachedAppointments = detachedAppointments.filter(
        (candidate) => candidate.id !== appointment.id,
      );
      trackUserAction();
      saveDetachedAppointments();
      render();
      return;
    }

    const day = schedule.find((d) => d.key === dayKeyValue);
    day.appointments = day.appointments.filter((a) => a.id !== appointment.id);
    trackUserAction();
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

  const dayHeading = document.createElement("div");
  dayHeading.className = "day-heading";
  dayHeading.append(dayChip, title);

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
    trackUserAction();
    saveSchedule();
    render();
  });

  if (day.tasks.length > 0) {
    const orderedTasks = day.tasks
      .filter((task) => task && !task.done)
      .concat(day.tasks.filter((task) => task && task.done));

    orderedTasks.forEach((task) => {
      taskList.append(createTaskElement(day.key, task));
    });
  } else {
    const empty = document.createElement("li");
    empty.className = "empty-marker";
    empty.innerHTML = '<span class="visually-hidden">Aucune tâche</span>';
    taskList.append(empty);
  }

  tasksSection.append(taskList);

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

  appointmentsSection.append(appointmentList);

  const quickAddSection = document.createElement("div");
  quickAddSection.className = "section quick-add-section";

  const quickAddToggle = document.createElement("button");
  quickAddToggle.type = "button";
  quickAddToggle.className = "quick-add-toggle";
  quickAddToggle.textContent = "Ajouter";
  quickAddToggle.setAttribute(
    "aria-label",
    `Ajouter une tâche ou un rendez-vous pour ${day.dayName} ${day.dateLabel}`,
  );

  const quickAddForm = document.createElement("form");
  quickAddForm.className = "quick-add-form";
  const quickTextId = `quick-text-${day.key}`;
  const quickTimeId = `quick-time-${day.key}`;
  const quickDurationId = `quick-duration-${day.key}`;
  quickAddForm.innerHTML = `
    <label class="visually-hidden" for="${quickTextId}">Que voulez-vous ajouter pour ${day.dayName} ${day.dateLabel}</label>
    <input id="${quickTextId}" name="quickText" type="text" placeholder="Ex: finaliser la présentation" required>
    <div class="quick-add-modes" role="group" aria-label="Type d'ajout">
      <button type="button" class="quick-mode active" data-mode="task">Tâche</button>
      <button type="button" class="quick-mode" data-mode="appointment">Rendez-vous</button>
    </div>
    <div class="quick-add-rdv-fields" data-role="appointment-fields">
      <div class="field-group">
        <label class="field-label" for="${quickTimeId}">Heure</label>
        <input id="${quickTimeId}" name="quickTime" type="time">
      </div>
      <div class="field-group">
        <label class="field-label" for="${quickDurationId}">Durée (min)</label>
        <input id="${quickDurationId}" name="quickDuration" type="number" min="5" step="5" value="60">
      </div>
    </div>
    <div class="quick-add-actions">
      <button type="submit" data-role="submit">Ajouter la tâche</button>
      <button type="button" class="ghost" data-role="cancel">Fermer</button>
    </div>
  `;

  const appointmentFieldsEl = quickAddForm.querySelector(
    '[data-role="appointment-fields"]',
  );
  const submitBtnEl = quickAddForm.querySelector('[data-role="submit"]');
  const cancelBtnEl = quickAddForm.querySelector('[data-role="cancel"]');
  const quickTextEl = quickAddForm.querySelector('[name="quickText"]');
  const modeButtons = quickAddForm.querySelectorAll(".quick-mode");
  let quickAddMode = "task";

  function updateQuickAddMode(nextMode) {
    quickAddMode = nextMode === "appointment" ? "appointment" : "task";
    const isAppointment = quickAddMode === "appointment";

    modeButtons.forEach((btn) => {
      const isActive = btn.dataset.mode === quickAddMode;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    if (appointmentFieldsEl) {
      appointmentFieldsEl.classList.toggle("show", isAppointment);
    }

    if (quickTextEl) {
      quickTextEl.placeholder = isAppointment
        ? "Ex: rendez-vous dentiste"
        : "Ex: finaliser la présentation";
    }

    if (submitBtnEl) {
      submitBtnEl.textContent = isAppointment
        ? "Ajouter le rendez-vous"
        : "Ajouter la tâche";
    }
  }

  function closeQuickAdd() {
    quickAddForm.classList.remove("open");
    quickAddForm.reset();
    updateQuickAddMode("task");
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      updateQuickAddMode(btn.dataset.mode || "task");
    });
  });

  quickAddToggle.addEventListener("click", () => {
    const willOpen = !quickAddForm.classList.contains("open");
    if (!willOpen) {
      closeQuickAdd();
      return;
    }

    quickAddForm.classList.add("open");
    updateQuickAddMode("task");
    if (quickTextEl) {
      quickTextEl.focus();
    }
  });

  if (cancelBtnEl) {
    cancelBtnEl.addEventListener("click", closeQuickAdd);
  }

  quickAddForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(quickAddForm);
    const text = String(formData.get("quickText") || "").trim();
    if (!text) {
      return;
    }

    if (quickAddMode === "task") {
      day.tasks.push({
        id: makeId(),
        text,
        done: false,
        createdAt: new Date().toISOString(),
      });
      trackUserAction();
      saveSchedule();
      render();
      return;
    }

    const time = String(formData.get("quickTime") || "").trim();
    const durationMinutes = Number(formData.get("quickDuration") || 0);
    if (!time || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return;
    }

    day.appointments.push({
      id: makeId(),
      time,
      text,
      durationMinutes: Math.round(durationMinutes),
      done: false,
    });
    trackUserAction();
    saveSchedule();
    render();
  });

  quickAddSection.append(quickAddToggle, quickAddForm);

  card.append(dayHeading, tasksSection, appointmentsSection, quickAddSection);
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
  if (autoPullTimer) {
    clearInterval(autoPullTimer);
    autoPullTimer = null;
  }

  if (pocketbase) {
    pocketbase.authStore.clear();
  }

  externalEvents = [];

  if (window.confirm("Effacer aussi les données locales de cet appareil ?")) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(RECURRING_STORAGE_KEY);
    localStorage.removeItem(DETACHED_APPOINTMENTS_STORAGE_KEY);
    localStorage.removeItem(RECURRING_TASK_STORAGE_KEY);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    localStorage.removeItem(ACTION_STATS_STORAGE_KEY);
  }

  redirectToLogin();
}

function bindPlannerControls() {
  cloudStatusEl = document.getElementById("cloud-status");
  calendarStatusEl = document.getElementById("calendar-status");
  cloudPullBtnEl = document.getElementById("cloud-pull");
  cloudPushBtnEl = document.getElementById("cloud-push");
  connectGoogleBtnEl = document.getElementById("connect-google");
  connectOutlookBtnEl = document.getElementById("connect-outlook");
  syncCalendarsBtnEl = document.getElementById("sync-calendars");
  layoutToggleBtnEl = document.getElementById("layout-toggle");
  plannerLogoutBtnEl = document.getElementById("planner-logout");

  if (cloudPullBtnEl) {
    cloudPullBtnEl.addEventListener("click", () => pullFromCloud(false));
  }
  if (cloudPushBtnEl) {
    cloudPushBtnEl.addEventListener("click", () => pushToCloud(false));
  }
  if (connectGoogleBtnEl) {
    connectGoogleBtnEl.addEventListener("click", () => beginCalendarConnect("google"));
  }
  if (connectOutlookBtnEl) {
    connectOutlookBtnEl.addEventListener("click", () => beginCalendarConnect("microsoft"));
  }
  if (syncCalendarsBtnEl) {
    syncCalendarsBtnEl.addEventListener("click", syncExternalCalendars);
  }
  if (plannerLogoutBtnEl) {
    plannerLogoutBtnEl.addEventListener("click", handleLogout);
  }
  if (layoutToggleBtnEl) {
    layoutToggleBtnEl.addEventListener("click", toggleLayoutMode);
  }

  const hasSavedLayoutMode = !!localStorage.getItem(LAYOUT_MODE_KEY);
  applyLayoutMode(hasSavedLayoutMode ? getSavedLayoutMode() : getDefaultLayoutMode());
  setCalendarStatus("Agendas externes non synchronisés.");

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
  initLucideIcons();
  bindPlannerControls();

  if (!ensureCloudSession()) {
    return;
  }

  schedule = loadSchedule();
  recurringRules = loadRecurringRules();
  recurringTaskRules = loadRecurringTaskRules();
  detachedAppointments = loadDetachedAppointments();
  recurringAppointmentDone = loadRecurringAppointmentDone();
  syncRecurringTasksIntoSchedule(schedule, recurringTaskRules);
  localStorage.setItem(
    RECURRING_TASK_STORAGE_KEY,
    JSON.stringify(recurringTaskRules),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  history = mergeScheduleIntoHistory(loadHistory(), schedule);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  const existingActionStats = loadActionStats();
  if (!existingActionStats) {
    saveActionStats({ total: 0, startedAt: new Date().toISOString(), byDay: {} });
  }
  bindRecurringTaskControls();
  render();
  updateCloudButtons();
  setCloudStatus("Session cloud active. Synchronisation en cours...");

  await pullFromCloud(true);
  await loadExternalEvents();
  render();
  setCalendarStatus("Événements externes chargés (lecture seule).", false);
  setCloudStatus("Session cloud active.");
  startAutoPull();
}

initApp();
