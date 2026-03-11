const ACTION_STATS_STORAGE_KEY = "quatorzaine_action_stats_v1";

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

function saveActionStats(actionStats) {
  localStorage.setItem(ACTION_STATS_STORAGE_KEY, JSON.stringify(actionStats));
}

function mergeActionStats(primaryStats, secondaryStats) {
  const primary = normalizeActionStats(primaryStats);
  const secondary = normalizeActionStats(secondaryStats);

  if (!primary && !secondary) {
    return null;
  }
  if (!primary) {
    return secondary;
  }
  if (!secondary) {
    return primary;
  }

  const mergedByDay = { ...secondary.byDay };
  Object.entries(primary.byDay).forEach(([key, value]) => {
    mergedByDay[key] = Math.max(mergedByDay[key] || 0, value);
  });

  const mergedTotal = Math.max(primary.total, secondary.total);

  const primaryStart = primary.startedAt ? new Date(primary.startedAt) : null;
  const secondaryStart = secondary.startedAt ? new Date(secondary.startedAt) : null;
  let mergedStartedAt = primary.startedAt || secondary.startedAt;
  if (
    primaryStart &&
    secondaryStart &&
    !Number.isNaN(primaryStart.getTime()) &&
    !Number.isNaN(secondaryStart.getTime())
  ) {
    mergedStartedAt = primaryStart < secondaryStart ? primary.startedAt : secondary.startedAt;
  }

  return {
    total: mergedTotal,
    startedAt: mergedStartedAt,
    byDay: mergedByDay,
  };
}
