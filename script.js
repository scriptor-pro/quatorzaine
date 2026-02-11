const STORAGE_KEY = "quatorzaine_schedule_v1";
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
const PB_EMAIL_KEY = "quatorzaine_pb_email";
const PB_COLLECTION = "planner_snapshots";

let schedule = [];
let pocketbase = null;
let cloudSaveTimer = null;

let cloudStatusEl;
let cloudAuthFormEl;
let cloudUrlEl;
let cloudEmailEl;
let cloudPasswordEl;
let cloudPullBtnEl;
let cloudPushBtnEl;
let cloudLogoutBtnEl;

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
      dateLabel: date.toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
      }),
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

function parseCloudScheduleValue(rawValue) {
  if (typeof rawValue === "string") {
    const text = rawValue.trim();
    if (!text) {
      return [];
    }

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed);
        } catch (_doubleEncodedError) {
          return [];
        }
      }
      return parsed;
    } catch (_invalidJsonError) {
      return [];
    }
  }

  if (Array.isArray(rawValue)) {
    return rawValue;
  }

  if (rawValue && typeof rawValue === "object") {
    return rawValue;
  }

  return [];
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

function launchConfetti() {
  if (!window.confetti) {
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
  cloudLogoutBtnEl.disabled = !connected;
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
    schedule: JSON.stringify(schedule),
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

    const parsed = parseCloudScheduleValue(record.schedule);
    schedule = normalizeSchedule(parsed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
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
    const payload = { schedule: JSON.stringify(schedule) };

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
  check.type = "checkbox";
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

  const text = document.createElement("span");
  text.className = "task-text";
  text.textContent = task.text;

  main.append(check, text);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  deleteBtn.textContent = "x";
  deleteBtn.setAttribute("aria-label", "Supprimer la tache");
  deleteBtn.addEventListener("click", () => {
    const day = schedule.find((d) => d.key === dayKeyValue);
    day.tasks = day.tasks.filter((t) => t.id !== task.id);
    saveSchedule();
    render();
  });

  li.append(main, deleteBtn);
  return li;
}

function createAppointmentElement(dayKeyValue, appointment) {
  const li = document.createElement("li");
  li.className = "appointment-item";

  const main = document.createElement("div");
  main.className = "appointment-main";

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

  main.append(time, text, duration);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete";
  deleteBtn.type = "button";
  deleteBtn.textContent = "x";
  deleteBtn.setAttribute("aria-label", "Supprimer le rendez-vous");
  deleteBtn.addEventListener("click", () => {
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

  const title = document.createElement("h2");
  title.className = "day-title";
  title.innerHTML = `${day.dayName} <span class="day-date">${day.dateLabel}</span>`;

  const tasksSection = document.createElement("div");
  tasksSection.className = "section";
  tasksSection.innerHTML = '<p class="section-title">Taches deplacables</p>';

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

  if (day.tasks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Aucune tache";
    taskList.append(empty);
  } else {
    day.tasks.forEach((task) =>
      taskList.append(createTaskElement(day.key, task)),
    );
  }

  const taskForm = document.createElement("form");
  taskForm.className = "inline-form";
  taskForm.innerHTML = `
    <input name="taskText" type="text" placeholder="Nouvelle tache" required>
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
  appointmentsSection.innerHTML =
    '<p class="section-title">Rendez-vous fixes</p>';

  const appointmentList = document.createElement("ul");
  if (day.appointments.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Aucun rendez-vous";
    appointmentList.append(empty);
  } else {
    day.appointments
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .forEach((appointment) => {
        appointmentList.append(createAppointmentElement(day.key, appointment));
      });
  }

  const appointmentForm = document.createElement("form");
  appointmentForm.className = "inline-form appointment-form";
  appointmentForm.innerHTML = `
    <input name="appointmentTime" type="time" required>
    <input name="appointmentDuration" type="number" min="5" step="5" value="60" placeholder="Duree (min)" required>
    <input name="appointmentText" type="text" placeholder="Rendez-vous" required>
    <button type="submit">Bloquer</button>
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

  card.append(title, tasksSection, appointmentsSection);
  return card;
}

function render() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  schedule.forEach((day) => {
    grid.append(createDayCard(day));
  });
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const url = cloudUrlEl.value.trim();
  const email = cloudEmailEl.value.trim();
  const password = cloudPasswordEl.value;

  if (!url || !email || !password) {
    setCloudStatus("Renseignez URL, email et mot de passe.", true);
    return;
  }

  try {
    initPocketBase(url);
    await pocketbase.collection("users").authWithPassword(email, password);

    localStorage.setItem(PB_URL_KEY, url);
    localStorage.setItem(PB_EMAIL_KEY, email);
    cloudPasswordEl.value = "";
    updateCloudButtons();

    setCloudStatus("Connexion reussie. Synchronisation cloud active.");

    const existing = await getSnapshotRecord(false);
    if (existing) {
      await pullFromCloud(true);
      setCloudStatus("Connexion reussie. Donnees cloud chargees.");
    } else {
      await pushToCloud(true);
      setCloudStatus("Connexion reussie. Snapshot cloud initialise.");
    }
  } catch (error) {
    setCloudStatus(`Echec de connexion: ${error.message}`, true);
    updateCloudButtons();
  }
}

function handleLogout() {
  if (pocketbase) {
    pocketbase.authStore.clear();
  }
  updateCloudButtons();
  setCloudStatus("Mode local uniquement.");
}

async function tryRestoreCloudSession() {
  const url = localStorage.getItem(PB_URL_KEY);
  const email = localStorage.getItem(PB_EMAIL_KEY);

  if (url) {
    cloudUrlEl.value = url;
  }
  if (email) {
    cloudEmailEl.value = email;
  }

  if (!url) {
    updateCloudButtons();
    return;
  }

  try {
    initPocketBase(url);

    if (pocketbase.authStore.isValid) {
      updateCloudButtons();
      setCloudStatus("Session cloud restauree. Synchronisation active.");
      await pullFromCloud(true);
      return;
    }
  } catch (error) {
    setCloudStatus(`Cloud indisponible: ${error.message}`, true);
  }

  updateCloudButtons();
}

function bindCloudControls() {
  cloudStatusEl = document.getElementById("cloud-status");
  cloudAuthFormEl = document.getElementById("cloud-auth-form");
  cloudUrlEl = document.getElementById("pb-url");
  cloudEmailEl = document.getElementById("pb-email");
  cloudPasswordEl = document.getElementById("pb-password");
  cloudPullBtnEl = document.getElementById("cloud-pull");
  cloudPushBtnEl = document.getElementById("cloud-push");
  cloudLogoutBtnEl = document.getElementById("cloud-logout");

  cloudAuthFormEl.addEventListener("submit", handleLoginSubmit);
  cloudPullBtnEl.addEventListener("click", () => pullFromCloud(false));
  cloudPushBtnEl.addEventListener("click", () => pushToCloud(false));
  cloudLogoutBtnEl.addEventListener("click", handleLogout);

  updateCloudButtons();
}

async function initApp() {
  schedule = loadSchedule();
  bindCloudControls();
  render();
  await tryRestoreCloudSession();
}

initApp();
