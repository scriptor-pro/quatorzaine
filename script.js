const STORAGE_KEY = "quatorzaine_schedule_v1";
const RECURRING_STORAGE_KEY = "quatorzaine_recurring_v1";
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
let pocketbase = null;
let cloudSaveTimer = null;

let cloudStatusEl;
let cloudPullBtnEl;
let cloudPushBtnEl;
let plannerLogoutBtnEl;

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
      if (!task || task.done) {
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

function parseCloudSnapshot(rawValue) {
  if (typeof rawValue === "string") {
    const text = rawValue.trim();
    if (!text) {
      return { schedule: [], recurringRules: [] };
    }

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") {
        try {
          return parseCloudSnapshot(parsed);
        } catch (_doubleEncodedError) {
          return { schedule: [], recurringRules: [] };
        }
      }
      return parseCloudSnapshot(parsed);
    } catch (_invalidJsonError) {
      return { schedule: [], recurringRules: [] };
    }
  }

  if (Array.isArray(rawValue)) {
    return { schedule: rawValue, recurringRules: [] };
  }

  if (rawValue && typeof rawValue === "object") {
    return {
      schedule: Array.isArray(rawValue.schedule) ? rawValue.schedule : [],
      recurringRules: Array.isArray(rawValue.recurringRules)
        ? rawValue.recurringRules
        : [],
    };
  }

  return { schedule: [], recurringRules: [] };
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

function saveSchedule() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  queueCloudSave();
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
  cloudPullBtnEl.disabled = !connected;
  cloudPushBtnEl.disabled = !connected;
  plannerLogoutBtnEl.disabled = !connected;
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
    throw new Error("Non connecte a PocketBase");
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
    setCloudStatus("Connectez-vous d'abord a PocketBase.", true);
    return;
  }

  try {
    const record = await getSnapshotRecord(false);
    if (!record) {
      if (!silent) {
        setCloudStatus("Aucun snapshot cloud trouve. Rien a telecharger.");
      }
      return;
    }

    const snapshot = parseCloudSnapshot(record.schedule);
    schedule = normalizeSchedule(snapshot.schedule);
    recurringRules = normalizeRecurringRules(snapshot.recurringRules);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
    localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(recurringRules));
    render();

    if (!silent) {
      setCloudStatus("Donnees cloud telechargees vers cet appareil.");
    }
  } catch (error) {
    setCloudStatus(`Echec du telechargement cloud: ${error.message}`, true);
  }
}

async function pushToCloud(silent = false) {
  if (!isCloudConnected()) {
    if (!silent) {
      setCloudStatus("Connectez-vous d'abord a PocketBase.", true);
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
      setCloudStatus("Donnees locales envoyees vers PocketBase.");
    }
  } catch (error) {
    setCloudStatus(`Echec de l'envoi cloud: ${error.message}`, true);
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

function promptMoveTargetDay(fromDayKey) {
  const options = schedule
    .map((day, index) => `${index + 1}. ${day.dayName} ${day.dateLabel}`)
    .join("\n");
  const answer = window.prompt(
    `Deplacer cette tache vers quel jour ?\n${options}`,
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

  return oneShots.concat(recurringForDay).sort((a, b) => {
    const aTime = parseTimeToMinutes(a.time || "");
    const bTime = parseTimeToMinutes(b.time || "");
    const aValue = aTime === null ? Number.POSITIVE_INFINITY : aTime;
    const bValue = bTime === null ? Number.POSITIVE_INFINITY : bTime;
    return aValue - bValue;
  });
}

function createTaskElement(dayKeyValue, task) {
  const li = document.createElement("li");
  li.className = `task-item${task.done ? " done" : ""}`;
  li.draggable = true;
  li.dataset.taskId = task.id;
  li.dataset.dayKey = dayKeyValue;

  li.addEventListener("dragstart", (event) => {
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
  text.textContent = task.text;

  main.append(check, text);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const moveBtn = document.createElement("button");
  moveBtn.className = "task-move";
  moveBtn.type = "button";
  moveBtn.textContent = "Deplacer";
  moveBtn.setAttribute("aria-label", "Deplacer la tache vers un autre jour");
  moveBtn.addEventListener("click", () => {
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
  deleteBtn.textContent = "x";
  deleteBtn.disabled = !task.done;
  deleteBtn.setAttribute(
    "aria-label",
    task.done
      ? "Supprimer la tache"
      : "Terminez la tache pour activer la suppression",
  );
  deleteBtn.title = task.done
    ? "Supprimer la tache"
    : "Terminez la tache pour pouvoir la supprimer";
  deleteBtn.addEventListener("click", () => {
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
  const durationLabel = formatDuration(appointment.durationMinutes);
  duration.textContent = appointment.isRecurring
    ? `${durationLabel} Recurrence`
    : durationLabel;

  topLine.append(time, duration);
  main.append(topLine, text);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  if (appointment.isRecurring) {
    deleteBtn.textContent = "...";
    deleteBtn.title = "Gerez les recurrents dans la page Rendez-vous";
    deleteBtn.setAttribute(
      "aria-label",
      "Gerer les rendez-vous recurrents depuis la page Rendez-vous",
    );
  } else {
    deleteBtn.textContent = "x";
    deleteBtn.setAttribute("aria-label", "Supprimer le rendez-vous");
  }
  deleteBtn.addEventListener("click", () => {
    if (appointment.isRecurring) {
      window.location.href = "rendezvous.html";
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
    empty.innerHTML = '<span class="visually-hidden">Aucune tache</span>';
    taskList.append(empty);
  }

  const taskForm = document.createElement("form");
  taskForm.className = "inline-form task-form";
  const taskInputId = `task-input-${day.key}`;
  taskForm.innerHTML = `
    <label class="visually-hidden" for="${taskInputId}">Nouvelle tache pour ${day.dayName} ${day.dateLabel}</label>
    <input id="${taskInputId}" name="taskText" type="text" placeholder="Nouvelle tache" required>
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
      <label class="field-label" for="${durationInputId}">Duree (min)</label>
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

  if (window.confirm("Effacer aussi les donnees locales de cet appareil ?")) {
    localStorage.removeItem(STORAGE_KEY);
  }

  redirectToLogin();
}

function bindPlannerControls() {
  cloudStatusEl = document.getElementById("cloud-status");
  cloudPullBtnEl = document.getElementById("cloud-pull");
  cloudPushBtnEl = document.getElementById("cloud-push");
  plannerLogoutBtnEl = document.getElementById("planner-logout");

  cloudPullBtnEl.addEventListener("click", () => pullFromCloud(false));
  cloudPushBtnEl.addEventListener("click", () => pushToCloud(false));
  plannerLogoutBtnEl.addEventListener("click", handleLogout);

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
  render();
  updateCloudButtons();
  setCloudStatus("Session cloud active. Synchronisation en cours...");

  await pullFromCloud(true);
  setCloudStatus("Session cloud active.");
}

initApp();
