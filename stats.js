const STORAGE_KEY = "quatorzaine_schedule_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
const ACTION_STATS_STORAGE_KEY = "quatorzaine_action_stats_v1";
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
  const historyRaw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (historyRaw) {
    try {
      const parsedHistory = JSON.parse(historyRaw);
      if (Array.isArray(parsedHistory)) {
        return parsedHistory;
      }
    } catch (_historyError) {
    }
  }

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

function normalizeActionStats(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const total = Number(rawValue.total);
  const startedAt = String(rawValue.startedAt || "").trim();
  const byDayRaw = rawValue.byDay && typeof rawValue.byDay === "object" ? rawValue.byDay : {};

  const byDay = Object.entries(byDayRaw).reduce((acc, [key, value]) => {
    if (!parseDayKeyToDate(key)) {
      return acc;
    }

    const parsedValue = Math.max(0, Math.floor(Number(value) || 0));
    if (parsedValue > 0) {
      acc[key] = parsedValue;
    }
    return acc;
  }, {});

  return {
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
    startedAt,
    byDay,
  };
}

function loadActionStats() {
  const savedRaw = localStorage.getItem(ACTION_STATS_STORAGE_KEY);
  if (!savedRaw) {
    return null;
  }

  try {
    return normalizeActionStats(JSON.parse(savedRaw));
  } catch (_error) {
    return null;
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

function getDailyDoneRows(schedule) {
  return schedule
    .map((day) => ({
      date: parseDayKeyToDate(day.key),
      finishedCount: getFinishedTaskCount(day),
    }))
    .filter((row) => !!row.date)
    .sort((a, b) => a.date - b.date);
}

function findLongestDoneStreak(schedule) {
  const rows = getDailyDoneRows(schedule);

  let bestLength = 0;
  let bestStart = null;
  let bestEnd = null;

  let currentLength = 0;
  let currentStart = null;
  let currentEnd = null;
  let previousDate = null;

  rows.forEach((row) => {
    const hasDoneTask = row.finishedCount > 0;
    if (!hasDoneTask) {
      currentLength = 0;
      currentStart = null;
      currentEnd = null;
      previousDate = row.date;
      return;
    }

    const isConsecutive =
      previousDate &&
      utcDayNumber(row.date) - utcDayNumber(previousDate) === 1 &&
      currentLength > 0;

    if (isConsecutive) {
      currentLength += 1;
      currentEnd = row.date;
    } else {
      currentLength = 1;
      currentStart = row.date;
      currentEnd = row.date;
    }

    if (currentLength > bestLength) {
      bestLength = currentLength;
      bestStart = currentStart;
      bestEnd = currentEnd;
    }

    previousDate = row.date;
  });

  return {
    length: bestLength,
    startDate: bestStart,
    endDate: bestEnd,
  };
}

function findCurrentDoneStreak(schedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayNumber = utcDayNumber(today);

  const doneByDayNumber = new Map(
    getDailyDoneRows(schedule).map((row) => [
      utcDayNumber(row.date),
      row.finishedCount > 0,
    ]),
  );

  let length = 0;
  let cursor = todayNumber;
  while (doneByDayNumber.get(cursor)) {
    length += 1;
    cursor -= 1;
  }

  if (length === 0) {
    return {
      length: 0,
      startDate: null,
      endDate: null,
    };
  }

  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (length - 1));
  startDate.setHours(0, 0, 0, 0);

  return {
    length,
    startDate,
    endDate: today,
  };
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

function utcDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

function renderStats() {
  const summaryEl = document.getElementById("stats-summary");
  const listEl = document.getElementById("stats-list");
  const streakValueEl = document.getElementById("streak-value");
  const streakRangeEl = document.getElementById("streak-range");
  const currentStreakValueEl = document.getElementById("current-streak-value");
  const currentStreakRangeEl = document.getElementById("current-streak-range");
  const actionsTodayValueEl = document.getElementById("actions-today-value");
  const actionsTodayRangeEl = document.getElementById("actions-today-range");
  const actionsTotalValueEl = document.getElementById("actions-total-value");
  const actionsTotalRangeEl = document.getElementById("actions-total-range");
  const schedule = loadSchedule();
  const actionStats = loadActionStats();
  const rows = createRankedRows(schedule);
  const streak = findLongestDoneStreak(schedule);
  const currentStreak = findCurrentDoneStreak(schedule);
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const actionsToday = actionStats?.byDay?.[todayKey] || 0;
  const totalActions = actionStats?.total || 0;

  if (actionsTodayValueEl && actionsTodayRangeEl && actionsTotalValueEl && actionsTotalRangeEl) {
    actionsTodayValueEl.textContent = `${actionsToday} action(s)`;
    actionsTodayRangeEl.textContent =
      actionsToday === 0
        ? "Aucune action enregistrée aujourd'hui."
        : "Compteur mis à jour à chaque modification de vos données.";

    actionsTotalValueEl.textContent = `${totalActions} action(s)`;
    if (actionStats?.startedAt) {
      const startedAt = new Date(actionStats.startedAt);
      if (!Number.isNaN(startedAt.getTime())) {
        actionsTotalRangeEl.textContent = `Suivi actif depuis le ${formatDateLabel(startedAt)}.`;
      } else {
        actionsTotalRangeEl.textContent = "Suivi actif depuis le début du compteur local/cloud.";
      }
    } else {
      actionsTotalRangeEl.textContent =
        "Le compteur d'actions commence à partir de cette version.";
    }
  }

  if (streak.length === 0) {
    streakValueEl.textContent = "0 jour actif";
    streakRangeEl.textContent = "Terminez au moins une tâche pour démarrer une série.";
  } else {
    streakValueEl.textContent =
      streak.length === 1
        ? "1 jour actif consécutif"
        : `${streak.length} jours actifs consécutifs`;
    streakRangeEl.textContent = `Du ${formatDateLabel(streak.startDate)} au ${formatDateLabel(streak.endDate)}.`;
  }

  if (currentStreak.length === 0) {
    currentStreakValueEl.textContent = "0 jour actif";
    currentStreakRangeEl.textContent =
      "Terminez au moins une tâche aujourd'hui pour démarrer la série en cours.";
  } else {
    currentStreakValueEl.textContent =
      currentStreak.length === 1
        ? "1 jour actif consécutif"
        : `${currentStreak.length} jours actifs consécutifs`;
    currentStreakRangeEl.textContent = `Du ${formatDateLabel(currentStreak.startDate)} à aujourd'hui.`;
  }

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
