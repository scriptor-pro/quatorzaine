const STORAGE_KEY = "quatorzaine_schedule_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
const DETACHED_APPOINTMENTS_STORAGE_KEY = "quatorzaine_detached_appointments_v1";
// ACTION_STATS_STORAGE_KEY and parseDayKeyToDate are defined in shared.js
const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

const INITIAL_LEADERBOARD_SIZE = 10;
let leaderboardExpanded = false;

function normalizeScheduleForStats(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((day) => {
      if (!day || typeof day !== "object") {
        return null;
      }

      const key = String(day.key || "").trim();
      if (!parseDayKeyToDate(key)) {
        return null;
      }

      const weekdayIndex = Number(day.weekdayIndex);
      const tasks = Array.isArray(day.tasks)
        ? day.tasks
            .filter((task) => task && typeof task === "object")
            .map((task) => ({
              text: String(task.text || ""),
              done: !!task.done,
            }))
        : [];

      const appointments = Array.isArray(day.appointments)
        ? day.appointments
            .filter((a) => a && typeof a === "object")
            .map((appointment) => ({
              text: String(appointment.text || ""),
              done: !!appointment.done,
            }))
        : [];

      return {
        key,
        weekdayIndex:
          Number.isInteger(weekdayIndex) && weekdayIndex >= 0 && weekdayIndex <= 6
            ? weekdayIndex
            : parseDayKeyToDate(key).getDay(),
        tasks,
        appointments,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function loadSchedule() {
  const historyRaw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (historyRaw) {
    try {
      const parsedHistory = JSON.parse(historyRaw);
      if (Array.isArray(parsedHistory)) {
        return normalizeScheduleForStats(parsedHistory);
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
    return Array.isArray(parsed) ? normalizeScheduleForStats(parsed) : [];
  } catch (_error) {
    return [];
  }
}

function loadCurrentSchedule() {
  const savedRaw = localStorage.getItem(STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(savedRaw);
    return Array.isArray(parsed) ? normalizeScheduleForStats(parsed) : [];
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
    const parsed = JSON.parse(savedRaw);
    return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a === "object") : [];
  } catch (_error) {
    return [];
  }
}

// normalizeActionStats and loadActionStats are defined in shared.js

function getFinishedTaskCount(day) {
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  const appointments = Array.isArray(day.appointments) ? day.appointments : [];
  const finishedTasks = tasks.filter((task) => task && task.done).length;
  const finishedAppointments = appointments.filter((appointment) => appointment && appointment.done).length;
  return finishedTasks + finishedAppointments;
}

function getTotalTaskCount(day) {
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  const appointments = Array.isArray(day.appointments) ? day.appointments : [];
  const totalTasks = tasks.filter((task) => task && typeof task === "object").length;
  const totalAppointments = appointments.filter((appointment) => appointment && typeof appointment === "object").length;
  return totalTasks + totalAppointments;
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
        totalCount: getTotalTaskCount(day),
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

  return rows;
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

// Fix #4: grace period — if today has no done tasks, count from yesterday
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

  let startFrom = todayNumber;
  let includesToday = true;

  if (!doneByDayNumber.get(todayNumber)) {
    startFrom = todayNumber - 1;
    includesToday = false;
  }

  let length = 0;
  let cursor = startFrom;
  while (doneByDayNumber.get(cursor)) {
    length += 1;
    cursor -= 1;
  }

  if (length === 0) {
    return {
      length: 0,
      startDate: null,
      endDate: null,
      includesToday: false,
    };
  }

  const endDate = new Date(today);
  endDate.setDate(today.getDate() - (todayNumber - startFrom));
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - (length - 1));
  startDate.setHours(0, 0, 0, 0);

  return {
    length,
    startDate,
    endDate,
    includesToday,
  };
}

// Fix #12: total done tasks within a date range
function computeStreakTotalDone(schedule, startDate, endDate) {
  if (!startDate || !endDate) {
    return 0;
  }

  return getDailyDoneRows(schedule)
    .filter((row) => row.date >= startDate && row.date <= endDate)
    .reduce((sum, row) => sum + row.finishedCount, 0);
}

// #5: average done tasks per active day
function computeAverageDonePerActiveDay(schedule) {
  const rows = getDailyDoneRows(schedule).filter((r) => r.finishedCount > 0);
  if (rows.length === 0) {
    return { average: 0, activeDays: 0 };
  }

  const total = rows.reduce((sum, r) => sum + r.finishedCount, 0);
  return {
    average: total / rows.length,
    activeDays: rows.length,
  };
}

// #7: completion rate
function computeCompletionRate(schedule) {
  let totalTasks = 0;
  let doneTasks = 0;

  schedule.forEach((day) => {
    const tasks = Array.isArray(day.tasks) ? day.tasks : [];
    totalTasks += tasks.length;
    doneTasks += tasks.filter((t) => t && t.done).length;
  });

  if (totalTasks === 0) {
    return null;
  }

  return {
    done: doneTasks,
    total: totalTasks,
    rate: doneTasks / totalTasks,
  };
}

// #8: most productive weekday
function computeBestWeekday(schedule) {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];

  schedule.forEach((day) => {
    const date = parseDayKeyToDate(day.key);
    if (!date) {
      return;
    }

    const idx =
      Number.isInteger(day.weekdayIndex) && day.weekdayIndex >= 0 && day.weekdayIndex <= 6
        ? day.weekdayIndex
        : date.getDay();
    const done = getFinishedTaskCount(day);
    if (done > 0) {
      totals[idx] += done;
      counts[idx] += 1;
    }
  });

  let bestIdx = -1;
  let bestAvg = 0;
  for (let i = 0; i < 7; i += 1) {
    if (counts[i] > 0) {
      const avg = totals[i] / counts[i];
      if (avg > bestAvg) {
        bestAvg = avg;
        bestIdx = i;
      }
    }
  }

  if (bestIdx < 0) {
    return null;
  }

  return {
    weekday: DAY_NAMES[bestIdx],
    average: bestAvg,
    totalDone: totals[bestIdx],
    dayCount: counts[bestIdx],
  };
}

// #6: weekly trends for last 12 weeks
function computeWeeklyTrends(schedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + mondayOffset);

  const weeks = [];
  for (let w = 11; w >= 0; w -= 1) {
    const weekStart = new Date(currentMonday);
    weekStart.setDate(currentMonday.getDate() - w * 7);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    weeks.push({ start: weekStart, end: weekEnd, done: 0 });
  }

  const doneRows = getDailyDoneRows(schedule);
  doneRows.forEach((row) => {
    for (let i = 0; i < weeks.length; i += 1) {
      if (row.date >= weeks[i].start && row.date <= weeks[i].end) {
        weeks[i].done += row.finishedCount;
        break;
      }
    }
  });

  return weeks;
}

// #9: appointment count from current schedule + detached
function countAppointments() {
  const currentSchedule = loadCurrentSchedule();
  let dayBound = 0;
  currentSchedule.forEach((day) => {
    if (Array.isArray(day.appointments)) {
      dayBound += day.appointments.length;
    }
  });

  const detached = loadDetachedAppointments();
  const detachedCount = detached.length;

  return {
    dayBound,
    detached: detachedCount,
    total: dayBound + detachedCount,
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

function formatShortDateLabel(date) {
  if (!date) {
    return "";
  }

  return date.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
  });
}

function utcDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

function setMetricValue(targetEl, valueText, labelText) {
  if (!targetEl) {
    return;
  }

  targetEl.textContent = "";

  const valueEl = document.createElement("span");
  valueEl.className = "streak-value-number";
  valueEl.textContent = String(valueText);

  const labelEl = document.createElement("span");
  labelEl.className = "streak-value-label";
  labelEl.textContent = String(labelText);

  targetEl.append(valueEl, labelEl);
}

function renderWeeklyChart(containerEl, weeks) {
  if (!containerEl) {
    return;
  }

  containerEl.innerHTML = "";

  const maxDone = Math.max(...weeks.map((w) => w.done), 1);

  weeks.forEach((week) => {
    const col = document.createElement("div");
    col.className = "chart-col";

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    const pct = Math.round((week.done / maxDone) * 100);
    bar.style.height = `${pct}%`;
    if (week.done === 0) {
      bar.classList.add("chart-bar-empty");
    }

    const valueLabel = document.createElement("span");
    valueLabel.className = "chart-bar-value";
    valueLabel.textContent = String(week.done);

    const dateLabel = document.createElement("span");
    dateLabel.className = "chart-bar-label";
    dateLabel.textContent = formatShortDateLabel(week.start);

    col.append(bar, valueLabel, dateLabel);
    containerEl.append(col);
  });
}

function renderLeaderboard(listEl, summaryEl, rows) {
  if (!listEl || !summaryEl) {
    return;
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

  const visibleCount = leaderboardExpanded ? rows.length : Math.min(rows.length, INITIAL_LEADERBOARD_SIZE);
  const totalLabel = rows.length === 1 ? "1 jour" : `${rows.length} jours`;
  const visibleLabel = visibleCount === rows.length
    ? totalLabel
    : `${visibleCount} sur ${totalLabel}`;
  summaryEl.textContent = `Affichage de ${visibleLabel} avec des tâches terminées.`;

  const visibleRows = rows.slice(0, visibleCount);

  visibleRows.forEach((row, index) => {
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

    const countContainer = document.createElement("div");
    countContainer.className = "stats-count-container";

    const count = document.createElement("span");
    count.className = "stats-count";
    count.textContent = `${row.finishedCount} / ${row.totalCount}`;

    const countLabel = document.createElement("span");
    countLabel.className = "stats-count-label";
    countLabel.textContent = row.totalCount > 0
      ? `${Math.round((row.finishedCount / row.totalCount) * 100)}%`
      : "";

    countContainer.append(count, countLabel);
    item.append(rank, day, countContainer);
    listEl.append(item);
  });

  // #11: show more / show less button
  if (rows.length > INITIAL_LEADERBOARD_SIZE) {
    const toggleItem = document.createElement("li");
    toggleItem.className = "stats-item stats-toggle";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "stats-toggle-btn";
    toggleBtn.type = "button";
    toggleBtn.textContent = leaderboardExpanded
      ? "Afficher moins"
      : `Afficher les ${rows.length} jours`;
    toggleBtn.addEventListener("click", () => {
      leaderboardExpanded = !leaderboardExpanded;
      renderStats();
    });

    toggleItem.append(toggleBtn);
    listEl.append(toggleItem);
  }
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
  const avgValueEl = document.getElementById("avg-done-value");
  const avgRangeEl = document.getElementById("avg-done-range");
  const completionValueEl = document.getElementById("completion-value");
  const completionRangeEl = document.getElementById("completion-range");
  const weekdayValueEl = document.getElementById("weekday-value");
  const weekdayRangeEl = document.getElementById("weekday-range");
  const appointmentsValueEl = document.getElementById("appointments-value");
  const appointmentsRangeEl = document.getElementById("appointments-range");
  const chartEl = document.getElementById("weekly-chart");

  const schedule = loadSchedule();
  const actionStats = loadActionStats();
  const rows = createRankedRows(schedule);
  const streak = findLongestDoneStreak(schedule);
  const currentStreak = findCurrentDoneStreak(schedule);
  const avgStats = computeAverageDonePerActiveDay(schedule);
  const completionStats = computeCompletionRate(schedule);
  const bestWeekday = computeBestWeekday(schedule);
  const weeklyTrends = computeWeeklyTrends(schedule);
  const appointmentStats = countAppointments();

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const actionsToday = actionStats?.byDay?.[todayKey] || 0;
  const totalActions = actionStats?.total || 0;

  // --- Actions card ---
  if (actionsTodayValueEl && actionsTodayRangeEl && actionsTotalValueEl && actionsTotalRangeEl) {
    setMetricValue(
      actionsTodayValueEl,
      actionsToday,
      actionsToday > 1 ? "actions" : "action",
    );
    actionsTodayRangeEl.textContent =
      actionsToday === 0
        ? "Aucune action enregistrée aujourd'hui."
        : "Compteur mis à jour à chaque modification de vos données.";

    setMetricValue(
      actionsTotalValueEl,
      totalActions,
      totalActions > 1 ? "actions" : "action",
    );
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

  // --- Longest streak card (#12: include total done) ---
  if (streak.length === 0) {
    setMetricValue(streakValueEl, 0, "jour actif");
    streakRangeEl.textContent = "Terminez au moins une tâche pour démarrer une série.";
  } else {
    setMetricValue(
      streakValueEl,
      streak.length,
      streak.length === 1 ? "jour actif consécutif" : "jours actifs consécutifs",
    );
    const streakDone = computeStreakTotalDone(schedule, streak.startDate, streak.endDate);
    const doneLabel = streakDone === 1 ? "tâche terminée" : "tâches terminées";
    streakRangeEl.textContent = `Du ${formatDateLabel(streak.startDate)} au ${formatDateLabel(streak.endDate)} — ${streakDone} ${doneLabel}.`;
  }

  // --- Current streak card (#4: grace period, #12: total done) ---
  if (currentStreak.length === 0) {
    setMetricValue(currentStreakValueEl, 0, "jour actif");
    currentStreakRangeEl.textContent =
      "Terminez au moins une tâche aujourd'hui pour démarrer la série en cours.";
  } else {
    setMetricValue(
      currentStreakValueEl,
      currentStreak.length,
      currentStreak.length === 1
        ? "jour actif consécutif"
        : "jours actifs consécutifs",
    );
    const currentDone = computeStreakTotalDone(schedule, currentStreak.startDate, currentStreak.endDate);
    const currentDoneLabel = currentDone === 1 ? "tâche terminée" : "tâches terminées";
    const todayNote = currentStreak.includesToday
      ? "à aujourd'hui"
      : "à hier — terminez une tâche aujourd'hui pour continuer";
    currentStreakRangeEl.textContent = `Du ${formatDateLabel(currentStreak.startDate)} ${todayNote} — ${currentDone} ${currentDoneLabel}.`;
  }

  // --- #5: Average done per active day ---
  if (avgValueEl && avgRangeEl) {
    if (avgStats.activeDays === 0) {
      setMetricValue(avgValueEl, "—", "");
      avgRangeEl.textContent = "Pas encore de données.";
    } else {
      setMetricValue(
        avgValueEl,
        avgStats.average.toFixed(1),
        avgStats.average > 1 ? "tâches / jour" : "tâche / jour",
      );
      const dayLabel = avgStats.activeDays === 1 ? "jour actif" : "jours actifs";
      avgRangeEl.textContent = `Calculée sur ${avgStats.activeDays} ${dayLabel}.`;
    }
  }

  // --- #7: Completion rate ---
  if (completionValueEl && completionRangeEl) {
    if (!completionStats) {
      setMetricValue(completionValueEl, "—", "");
      completionRangeEl.textContent = "Pas encore de tâches enregistrées.";
    } else {
      setMetricValue(
        completionValueEl,
        `${Math.round(completionStats.rate * 100)}%`,
        "de complétion",
      );
      completionRangeEl.textContent = `${completionStats.done} terminée${completionStats.done > 1 ? "s" : ""} sur ${completionStats.total} tâche${completionStats.total > 1 ? "s" : ""} au total.`;
    }
  }

  // --- #8: Best weekday ---
  if (weekdayValueEl && weekdayRangeEl) {
    if (!bestWeekday) {
      setMetricValue(weekdayValueEl, "—", "");
      weekdayRangeEl.textContent = "Pas encore de données.";
    } else {
      setMetricValue(weekdayValueEl, bestWeekday.weekday, "");
      weekdayRangeEl.textContent = `${bestWeekday.average.toFixed(1)} tâche${bestWeekday.average > 1 ? "s" : ""} en moyenne (${bestWeekday.dayCount} ${bestWeekday.dayCount === 1 ? "occurrence" : "occurrences"}).`;
    }
  }

  // --- #9: Appointments ---
  if (appointmentsValueEl && appointmentsRangeEl) {
    if (appointmentStats.total === 0) {
      setMetricValue(appointmentsValueEl, 0, "rendez-vous");
      appointmentsRangeEl.textContent = "Aucun rendez-vous dans le planner actuel.";
    } else {
      setMetricValue(
        appointmentsValueEl,
        appointmentStats.total,
        appointmentStats.total > 1 ? "rendez-vous" : "rendez-vous",
      );
      const parts = [];
      if (appointmentStats.dayBound > 0) {
        parts.push(`${appointmentStats.dayBound} dans le calendrier`);
      }
      if (appointmentStats.detached > 0) {
        parts.push(`${appointmentStats.detached} détaché${appointmentStats.detached > 1 ? "s" : ""}`);
      }
      appointmentsRangeEl.textContent = `${parts.join(", ")} (planner actuel).`;
    }
  }

  // --- #6: Weekly trends chart ---
  renderWeeklyChart(chartEl, weeklyTrends);

  // --- Leaderboard (#11: show more) ---
  renderLeaderboard(listEl, summaryEl, rows);
}

renderStats();

// #10: re-render when page becomes visible again
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    renderStats();
  }
});
