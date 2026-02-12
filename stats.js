const STORAGE_KEY = "quatorzaine_schedule_v1";
const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

function parseDayKeyToDate(value) {
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
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function loadSchedule() {
  const savedRaw = localStorage.getItem(STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(savedRaw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function getFinishedTaskCount(day) {
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  return tasks.filter((task) => task && task.done).length;
}

function createRankedRows(schedule) {
  const rows = schedule
    .map((day) => {
      const date = parseDayKeyToDate(day.key);
      const weekdayName =
        Number.isInteger(day.weekdayIndex) && day.weekdayIndex >= 0 && day.weekdayIndex <= 6
          ? DAY_NAMES[day.weekdayIndex]
          : date
            ? DAY_NAMES[date.getDay()]
            : "Jour";

      return {
        key: day.key,
        date,
        weekdayName,
        finishedCount: getFinishedTaskCount(day),
      };
    })
    .filter((row) => row.finishedCount > 0)
    .sort((a, b) => {
      if (b.finishedCount !== a.finishedCount) {
        return b.finishedCount - a.finishedCount;
      }

      if (a.date && b.date) {
        return a.date - b.date;
      }

      return String(a.key).localeCompare(String(b.key));
    });

  return rows.slice(0, 10);
}

function formatDateLabel(date) {
  if (!date) {
    return "Date inconnue";
  }

  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function renderStats() {
  const summaryEl = document.getElementById("stats-summary");
  const listEl = document.getElementById("stats-list");
  const schedule = loadSchedule();
  const rows = createRankedRows(schedule);

  listEl.innerHTML = "";

  if (rows.length === 0) {
    summaryEl.textContent = "Aucune tâche terminée trouvée pour le moment.";

    const emptyEl = document.createElement("li");
    emptyEl.className = "stats-item empty";
    emptyEl.textContent = "Terminez des tâches dans le planner pour afficher ce classement.";
    listEl.append(emptyEl);
    return;
  }

  summaryEl.textContent = `Affichage des ${rows.length} jour(s) avec le plus de tâches terminées.`;

  rows.forEach((row, index) => {
    const item = document.createElement("li");
    item.className = "stats-item";

    const rank = document.createElement("span");
    rank.className = "stats-rank";
    rank.textContent = String(index + 1);

    const day = document.createElement("div");
    day.className = "stats-day";

    const title = document.createElement("strong");
    title.textContent = row.weekdayName;

    const date = document.createElement("span");
    date.className = "stats-date";
    date.textContent = formatDateLabel(row.date);

    day.append(title, date);

    const count = document.createElement("span");
    count.className = "stats-count";
    count.textContent = `${row.finishedCount} tâche(s)`;

    item.append(rank, day, count);
    listEl.append(item);
  });
}

renderStats();
