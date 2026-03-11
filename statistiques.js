const STORAGE_KEY = "quatorzaine_schedule_v1";
const HISTORY_STORAGE_KEY = "quatorzaine_history_v1";
const PB_URL_KEY = "quatorzaine_pb_url";

const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

let pocketbase = null;

// DOM elements
let currentStreakEl;
let recordStreakEl;
let streakBarFillEl;
let tasksCompletedEl;
let tasksCompletedContextEl;
let completionRateEl;
let completionBarFillEl;
let appointmentsCountEl;
let appointmentsContextEl;
let averagePerDayEl;
let weeklyChartEl;
let bestDaysListEl;
let statsLogoutBtnEl;

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

function loadSchedule() {
  const savedRaw = localStorage.getItem(STORAGE_KEY);
  if (!savedRaw) {
    return [];
  }

  try {
    return JSON.parse(savedRaw);
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
    return JSON.parse(savedRaw);
  } catch (_error) {
    return [];
  }
}

// Calculate statistics from schedule and history
function calculateStats() {
  const schedule = loadSchedule();
  const history = loadHistory();

  // Combine schedule and history for comprehensive stats
  const allDays = new Map();

  // Add history data
  history.forEach((day) => {
    if (day && day.key) {
      allDays.set(day.key, {
        key: day.key,
        weekdayIndex: day.weekdayIndex,
        tasks: day.tasks || [],
      });
    }
  });

  // Add/merge current schedule
  schedule.forEach((day) => {
    if (day && day.key) {
      const existing = allDays.get(day.key);
      if (existing) {
        // Merge tasks, avoiding duplicates
        const taskIds = new Set(existing.tasks.map((t) => t.id));
        const newTasks = (day.tasks || []).filter((t) => !taskIds.has(t.id));
        existing.tasks = [...existing.tasks, ...newTasks];
      } else {
        allDays.set(day.key, {
          key: day.key,
          weekdayIndex: day.weekdayIndex,
          tasks: day.tasks || [],
          appointments: day.appointments || [],
        });
      }
    }
  });

  // Convert to array and sort by date
  const sortedDays = Array.from(allDays.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  return {
    allDays: sortedDays,
    currentSchedule: schedule,
  };
}

// Calculate streak (consecutive days with completed tasks)
function calculateStreak(allDays) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dayKey(today);

  // Get days with completed tasks
  const daysWithCompletedTasks = allDays
    .filter((day) => {
      const tasks = day.tasks || [];
      return tasks.some((t) => t.done);
    })
    .map((day) => day.key)
    .sort();

  if (daysWithCompletedTasks.length === 0) {
    return { current: 0, record: 0 };
  }

  // Calculate current streak (working backwards from today)
  let currentStreak = 0;
  let checkDate = new Date(today);

  while (true) {
    const checkKey = dayKey(checkDate);
    if (daysWithCompletedTasks.includes(checkKey)) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Calculate longest streak
  let longestStreak = 0;
  let tempStreak = 1;
  let prevDate = dayKeyToDate(daysWithCompletedTasks[0]);

  for (let i = 1; i < daysWithCompletedTasks.length; i++) {
    const currentDate = dayKeyToDate(daysWithCompletedTasks[i]);
    const daysDiff = Math.round(
      (currentDate - prevDate) / (1000 * 60 * 60 * 24)
    );

    if (daysDiff === 1) {
      tempStreak++;
    } else {
      longestStreak = Math.max(longestStreak, tempStreak);
      tempStreak = 1;
    }

    prevDate = currentDate;
  }

  longestStreak = Math.max(longestStreak, tempStreak);

  return {
    current: currentStreak,
    record: longestStreak,
  };
}

// Calculate completion metrics
function calculateCompletionMetrics(allDays) {
  let totalTasks = 0;
  let completedTasks = 0;

  allDays.forEach((day) => {
    const tasks = day.tasks || [];
    tasks.forEach((task) => {
      totalTasks++;
      if (task.done) {
        completedTasks++;
      }
    });
  });

  const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return {
    totalTasks,
    completedTasks,
    completionRate,
  };
}

// Calculate appointments count
function calculateAppointments(currentSchedule) {
  let totalAppointments = 0;

  currentSchedule.forEach((day) => {
    const appointments = day.appointments || [];
    totalAppointments += appointments.length;
  });

  return totalAppointments;
}

// Calculate average tasks per day
function calculateAverage(allDays) {
  const daysWithTasks = allDays.filter((day) => {
    const completedTasks = (day.tasks || []).filter((t) => t.done);
    return completedTasks.length > 0;
  });

  if (daysWithTasks.length === 0) {
    return 0;
  }

  let totalCompleted = 0;
  daysWithTasks.forEach((day) => {
    totalCompleted += (day.tasks || []).filter((t) => t.done).length;
  });

  return totalCompleted / daysWithTasks.length;
}

// Get last 14 days for weekly trend
function getLast14Days(allDays) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const last14Days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = dayKey(date);

    const dayData = allDays.find((d) => d.key === key);
    const completedCount = dayData
      ? (dayData.tasks || []).filter((t) => t.done).length
      : 0;

    last14Days.push({
      key,
      date,
      weekdayIndex: date.getDay(),
      completedCount,
      isToday: key === dayKey(today),
    });
  }

  return last14Days;
}

// Get best performing days (by weekday average)
function getBestDays(allDays) {
  const byWeekday = {};

  // Initialize all weekdays
  for (let i = 0; i < 7; i++) {
    byWeekday[i] = { total: 0, count: 0, dates: [] };
  }

  // Aggregate by weekday
  allDays.forEach((day) => {
    const completedCount = (day.tasks || []).filter((t) => t.done).length;
    if (completedCount > 0) {
      const weekday = day.weekdayIndex;
      byWeekday[weekday].total += completedCount;
      byWeekday[weekday].count += 1;
      byWeekday[weekday].dates.push({ key: day.key, count: completedCount });
    }
  });

  // Calculate averages and sort
  const weekdayAverages = Object.keys(byWeekday).map((weekdayIndex) => {
    const data = byWeekday[weekdayIndex];
    const avg = data.count > 0 ? data.total / data.count : 0;
    
    // Get most recent date for this weekday
    const sortedDates = data.dates.sort((a, b) => b.key.localeCompare(a.key));
    const recentDate = sortedDates[0] ? sortedDates[0].key : null;

    return {
      weekdayIndex: Number(weekdayIndex),
      weekdayName: DAY_NAMES[weekdayIndex],
      average: avg,
      recentDate,
    };
  });

  // Sort by average (descending) and return top 5
  return weekdayAverages
    .filter((day) => day.average > 0)
    .sort((a, b) => b.average - a.average)
    .slice(0, 5);
}

// Render functions
function renderStreak(streak) {
  currentStreakEl.textContent = streak.current;
  recordStreakEl.textContent = streak.record;

  const percentage = streak.record > 0 ? (streak.current / streak.record) * 100 : 0;
  streakBarFillEl.style.width = `${Math.min(percentage, 100)}%`;
}

function renderMetrics(stats) {
  const { allDays, currentSchedule } = stats;

  const metrics = calculateCompletionMetrics(allDays);
  const appointments = calculateAppointments(currentSchedule);
  const average = calculateAverage(allDays);

  tasksCompletedEl.textContent = metrics.completedTasks;
  
  // Calculate recent trend (last 7 days)
  const last7Days = getLast14Days(allDays).slice(7);
  const recentCompleted = last7Days.reduce((sum, day) => sum + day.completedCount, 0);
  tasksCompletedContextEl.textContent = `${recentCompleted} cette semaine`;

  completionRateEl.textContent = `${Math.round(metrics.completionRate)}%`;
  completionBarFillEl.style.width = `${Math.min(metrics.completionRate, 100)}%`;

  appointmentsCountEl.textContent = appointments;
  appointmentsContextEl.textContent = appointments === 1 ? "rendez-vous prévu" : "rendez-vous prévus";

  averagePerDayEl.textContent = average.toFixed(1);
}

function renderWeeklyChart(last14Days) {
  const maxCount = Math.max(...last14Days.map((d) => d.completedCount), 1);

  weeklyChartEl.innerHTML = "";

  if (last14Days.every((d) => d.completedCount === 0)) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <div class="empty-state-icon">
        <i data-lucide="bar-chart-3"></i>
      </div>
      <p class="empty-state-text">Aucune tâche terminée ces 14 derniers jours</p>
    `;
    weeklyChartEl.appendChild(emptyState);
    initLucideIcons();
    return;
  }

  // Find best day for highlighting
  const bestCount = Math.max(...last14Days.map((d) => d.completedCount));

  last14Days.forEach((day) => {
    const barWrapper = document.createElement("div");
    barWrapper.className = "day-bar";
    if (day.isToday) {
      barWrapper.classList.add("is-today");
    }
    if (day.completedCount === bestCount && bestCount > 0) {
      barWrapper.classList.add("is-best");
    }

    const barContainer = document.createElement("div");
    barContainer.className = "day-bar-container";

    const barFill = document.createElement("div");
    barFill.className = "day-bar-fill";
    barFill.setAttribute("data-count", day.completedCount);
    const heightPercent = maxCount > 0 ? (day.completedCount / maxCount) * 100 : 0;
    barFill.style.height = `${Math.max(heightPercent, 3)}%`;

    barContainer.appendChild(barFill);

    const label = document.createElement("div");
    label.className = "day-label";
    
    const dayName = DAY_NAMES[day.weekdayIndex].slice(0, 3);
    const dateLabel = document.createElement("span");
    dateLabel.className = "day-label-date";
    dateLabel.textContent = day.date.getDate();
    
    label.textContent = dayName;
    label.appendChild(dateLabel);

    barWrapper.appendChild(barContainer);
    barWrapper.appendChild(label);

    weeklyChartEl.appendChild(barWrapper);
  });
}

function renderBestDays(bestDays) {
  bestDaysListEl.innerHTML = "";

  if (bestDays.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <div class="empty-state-icon">
        <i data-lucide="award"></i>
      </div>
      <p class="empty-state-text">Commencez à compléter des tâches pour voir vos meilleurs jours</p>
    `;
    bestDaysListEl.appendChild(emptyState);
    initLucideIcons();
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];

  bestDays.forEach((day, index) => {
    const item = document.createElement("div");
    item.className = "best-day-item";

    const rank = document.createElement("div");
    rank.className = "best-day-rank";
    rank.textContent = index < 3 ? medals[index] : `${index + 1}`;

    const info = document.createElement("div");
    info.className = "best-day-info";

    const name = document.createElement("div");
    name.className = "best-day-name";
    name.textContent = day.weekdayName;

    const date = document.createElement("div");
    date.className = "best-day-date";
    if (day.recentDate) {
      const dateObj = dayKeyToDate(day.recentDate);
      if (dateObj) {
        date.textContent = `Dernier : ${dateObj.toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "short",
        })}`;
      }
    }

    info.appendChild(name);
    info.appendChild(date);

    const metric = document.createElement("div");
    metric.className = "best-day-metric";

    const tasks = document.createElement("div");
    tasks.className = "best-day-tasks";
    tasks.textContent = day.average.toFixed(1);

    const label = document.createElement("div");
    label.className = "best-day-label";
    label.textContent = "tâches/jour";

    metric.appendChild(tasks);
    metric.appendChild(label);

    item.appendChild(rank);
    item.appendChild(info);
    item.appendChild(metric);

    bestDaysListEl.appendChild(item);
  });
}

function render() {
  const stats = calculateStats();
  const streak = calculateStreak(stats.allDays);
  const last14Days = getLast14Days(stats.allDays);
  const bestDays = getBestDays(stats.allDays);

  renderStreak(streak);
  renderMetrics(stats);
  renderWeeklyChart(last14Days);
  renderBestDays(bestDays);

  initLucideIcons();
}

function handleLogout() {
  if (!confirm("Voulez-vous vous déconnecter ?")) {
    return;
  }

  if (pocketbase) {
    pocketbase.authStore.clear();
  }

  window.location.href = "index.html";
}

async function init() {
  // Get DOM elements
  currentStreakEl = document.getElementById("current-streak");
  recordStreakEl = document.getElementById("record-streak");
  streakBarFillEl = document.getElementById("streak-bar-fill");
  tasksCompletedEl = document.getElementById("tasks-completed");
  tasksCompletedContextEl = document.getElementById("tasks-completed-context");
  completionRateEl = document.getElementById("completion-rate");
  completionBarFillEl = document.getElementById("completion-bar-fill");
  appointmentsCountEl = document.getElementById("appointments-count");
  appointmentsContextEl = document.getElementById("appointments-context");
  averagePerDayEl = document.getElementById("average-per-day");
  weeklyChartEl = document.getElementById("weekly-chart");
  bestDaysListEl = document.getElementById("best-days-list");
  statsLogoutBtnEl = document.getElementById("stats-logout");

  // Setup event listeners
  if (statsLogoutBtnEl) {
    statsLogoutBtnEl.addEventListener("click", handleLogout);
  }

  // Initialize PocketBase if available
  const pbUrl = localStorage.getItem(PB_URL_KEY);
  if (pbUrl && window.PocketBase) {
    try {
      pocketbase = new window.PocketBase(pbUrl);
    } catch (_error) {
      // Silent fail
    }
  }

  // Render statistics
  render();

  initLucideIcons();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
