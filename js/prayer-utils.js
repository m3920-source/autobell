'use strict';
// Pure helper functions for prayer reminder scheduling.
// UMD: browser -> window.PrayerUtils, Node -> module.exports (unit tested).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PrayerUtils = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const SECONDS_PER_DAY = 86400;

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    // "HH:MM" | "HH:MM:SS" -> seconds since midnight, or null if invalid
    function parseTimeToSeconds(time) {
        if (typeof time !== 'string') return null;
        const match = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = match[3] !== undefined ? Number(match[3]) : 0;
        if (hours > 23 || minutes > 59 || seconds > 59) return null;
        return hours * 3600 + minutes * 60 + seconds;
    }

    // "11:52:00", 10 -> "11:42:00"; wraps around midnight; null on invalid input
    function computeReminderTime(time, offsetMinutes) {
        const total = parseTimeToSeconds(time);
        if (total === null) return null;
        if (typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes) || offsetMinutes < 0) {
            return null;
        }
        const offsetSeconds = Math.floor(offsetMinutes) * 60;
        const reminder = ((total - offsetSeconds) % SECONDS_PER_DAY + SECONDS_PER_DAY) % SECONDS_PER_DAY;
        const hours = Math.floor(reminder / 3600);
        const minutes = Math.floor((reminder % 3600) / 60);
        const seconds = reminder % 60;
        return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    }

    // Returns a new array; inputs are never mutated. Sorted ascending by time.
    function mergeSchedules(staticItems, prayerItems) {
        const listA = Array.isArray(staticItems) ? staticItems : [];
        const listB = Array.isArray(prayerItems) ? prayerItems : [];
        return listA.concat(listB).sort((x, y) => {
            if (x.time < y.time) return -1;
            if (x.time > y.time) return 1;
            return 0;
        });
    }

    // Bounds: dhuhr 11:00-13:30, ashr strictly after dhuhr and <= 18:30,
    // and both within toleranceMinutes of the computed values.
    function isValidAiTimes(aiTimes, computedTimes, toleranceMinutes) {
        if (!aiTimes || !computedTimes) return false;
        const aiDhuhr = parseTimeToSeconds(aiTimes.dhuhr);
        const aiAshr = parseTimeToSeconds(aiTimes.ashr);
        const calcDhuhr = parseTimeToSeconds(computedTimes.dhuhr);
        const calcAshr = parseTimeToSeconds(computedTimes.ashr);
        if (aiDhuhr === null || aiAshr === null || calcDhuhr === null || calcAshr === null) return false;
        if (typeof toleranceMinutes !== 'number' || !Number.isFinite(toleranceMinutes)) return false;

        const DHHUHR_MIN = 11 * 3600;
        const DHHUHR_MAX = 13 * 3600 + 30 * 60;
        const ASHR_MAX = 18 * 3600 + 30 * 60;
        if (aiDhuhr < DHHUHR_MIN || aiDhuhr > DHHUHR_MAX) return false;
        if (aiAshr <= aiDhuhr || aiAshr > ASHR_MAX) return false;

        const toleranceSeconds = toleranceMinutes * 60;
        if (Math.abs(aiDhuhr - calcDhuhr) > toleranceSeconds) return false;
        if (Math.abs(aiAshr - calcAshr) > toleranceSeconds) return false;
        return true;
    }

    // Dedupe key for fired bells: "YYYY-MM-DD|HH:MM:SS|soundKey"
    function buildFiredKey(dateStr, time, sound) {
        return `${dateStr}|${time}|${sound}`;
    }

    return {
        parseTimeToSeconds,
        computeReminderTime,
        mergeSchedules,
        isValidAiTimes,
        buildFiredKey
    };
});
