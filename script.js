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

let schedule = [];

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

function loadSchedule() {
  const base = buildBaseSchedule();
  const savedRaw = localStorage.getItem(STORAGE_KEY);
  if (!savedRaw) {
    return base;
  }

  try {
    const saved = JSON.parse(savedRaw);
    const byKey = new Map(saved.map((day) => [day.key, day]));
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
  } catch (_error) {
    return base;
  }
}

function saveSchedule() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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
  time.textContent = appointment.time || "--:--";

  const text = document.createElement("span");
  text.className = "appointment-text";
  text.textContent = appointment.text;

  main.append(time, text);

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
    <input name="appointmentText" type="text" placeholder="Rendez-vous" required>
    <button type="submit">Bloquer</button>
  `;
  appointmentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(appointmentForm);
    const time = String(formData.get("appointmentTime") || "").trim();
    const text = String(formData.get("appointmentText") || "").trim();
    if (!time || !text) {
      return;
    }
    day.appointments.push({ id: makeId(), time, text });
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

schedule = loadSchedule();
render();
